import { generateObject, NoObjectGeneratedError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  MODELS,
  SURPLUS_URL,
  PROMPT,
  TaskSchema,
  SCHEMA_KEYS,
  REASONING_EFFORT,
  MAX_OUTPUT_TOKENS,
  TIMEOUT_MS,
} from "./models";

export type FailKind =
  | "timeout"
  | "truncated"
  | "markdown_fence"
  | "schema_mismatch"
  | "prose"
  | "empty"
  | "parse_error"
  | "error";

export interface Result {
  model: string;
  ok: boolean; // structured output produced and schema-valid
  jsonValid: boolean;
  error: string | null;
  failKind: FailKind | null;
  /** raw model text (truncated) so the UI can show what actually came back */
  rawPreview: string | null;
  finishReason: string | null; // stop | length | error | timeout | ...
  /** Not measured with generateObject (no stream). Kept for UI/history compat. */
  ttft: number | null;
  duration: number; // seconds, total wall time for the call
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  thinking: boolean;
  /** Always false with non-streaming generateObject — no reasoning stream. */
  thinkingVisible: boolean;
  reasoningEffort: string;
  tokPerSec: number | null; // content tokens / duration
  costUSD: number;
}

export type ProgressEvent =
  | { type: "start"; models: string[]; at: number; reasoningEffort: string }
  | { type: "result"; result: Result; done: number; total: number }
  | { type: "done"; run: Run }
  | { type: "skipped"; run: Run }
  | { type: "error"; error: string };

function provider(key: string) {
  return createOpenAICompatible({
    name: "surplus",
    baseURL: SURPLUS_URL,
    apiKey: key,
    supportsStructuredOutputs: true,
    includeUsage: true,
  });
}

function stripMarkdownFence(text: string): { fenced: boolean; body: string } {
  const m = text.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  if (m) return { fenced: true, body: m[1].trim() };
  if (/^```/.test(text)) {
    return {
      fenced: true,
      body: text.replace(/^```(?:json|JSON)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim(),
    };
  }
  return { fenced: false, body: text };
}

/**
 * Classify WHY structured output failed. Most "similar" failures across models
 * are the same root cause: the marketplace seller did NOT enforce json_schema,
 * so the model free-wrote JSON from the English prompt (snake_case keys,
 * markdown fences) instead of constrained decoding to the schema.
 */
function diagnose(e: unknown): {
  failKind: FailKind;
  finishReason: string | null;
  tokensOut: number;
  reasoningTokens: number;
  costUSD: number;
  note: string;
  rawPreview: string | null;
} {
  if (NoObjectGeneratedError.isInstance(e)) {
    const u: any = e.usage ?? {};
    const reasoningTokens =
      u.outputTokenDetails?.reasoningTokens ??
      u.raw?.completion_tokens_details?.reasoning_tokens ??
      0;
    const text = (e.text ?? "").trim();
    const fr = (e.finishReason as string | undefined) ?? null;
    const usage = {
      finishReason: fr,
      tokensOut: u.outputTokens ?? 0,
      reasoningTokens,
      costUSD: Math.round((u.raw?.cost ?? 0) * 1e6) / 1e6,
      rawPreview: text ? text.slice(0, 2000) : null,
    };

    if (fr === "length") {
      return {
        ...usage,
        failKind: "truncated",
        note: `truncated at ${MAX_OUTPUT_TOKENS} tok (thought ${reasoningTokens}) — JSON incomplete`,
      };
    }
    if (!text) {
      return { ...usage, failKind: "empty", note: "empty / refusal — no content returned" };
    }

    const { fenced, body } = stripMarkdownFence(text);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* not JSON even after unwrapping */
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const got = Object.keys(parsed as object);
      const expected = [...SCHEMA_KEYS];
      const missing = expected.filter((k) => !(k in (parsed as object)));
      const extra = got.filter((k) => !expected.includes(k as (typeof SCHEMA_KEYS)[number]));
      const parts = [
        fenced ? "markdown-fenced JSON" : "JSON",
        "but wrong shape",
        `got {${got.join(", ") || "∅"}}`,
        `need {${expected.join(", ")}}`,
      ];
      if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
      if (extra.length) parts.push(`extra: ${extra.join(", ")}`);
      parts.push("— seller ignored strict schema");
      return {
        ...usage,
        failKind: "schema_mismatch",
        note: parts.join(" · "),
      };
    }

    if (fenced) {
      return {
        ...usage,
        failKind: "markdown_fence",
        note: `markdown fence, not parseable JSON — seller ignored strict schema · ${body.slice(0, 2000)}`,
      };
    }

    if (!/^\s*[\[{]/.test(text)) {
      return {
        ...usage,
        failKind: "prose",
        note: `prose, not JSON — seller ignored strict schema · ${text.replace(/\s+/g, " ").slice(0, 2000)}`,
      };
    }

    return {
      ...usage,
      failKind: "parse_error",
      note: `invalid JSON · ${text.replace(/\s+/g, " ").slice(0, 2000)}`,
    };
  }

  return {
    failKind: "error",
    finishReason: null,
    tokensOut: 0,
    reasoningTokens: 0,
    costUSD: 0,
    note: String((e as any)?.message ?? e).replace(/\s+/g, " ").slice(0, 2000),
    rawPreview: null,
  };
}

function failResult(
  model: string,
  t0: number,
  error: string,
  extra?: Partial<Result>,
): Result {
  return {
    model,
    ok: false,
    jsonValid: false,
    finishReason: null,
    failKind: null,
    rawPreview: null,
    ttft: null,
    thinking: false,
    thinkingVisible: false,
    reasoningEffort: REASONING_EFFORT,
    duration: Math.round(((Date.now() - t0) / 1000) * 10) / 10,
    tokensIn: 0,
    tokensOut: 0,
    reasoningTokens: 0,
    tokPerSec: null,
    costUSD: 0,
    error,
    ...extra,
  };
}

async function attempt(model: string, key: string): Promise<Result> {
  const surplus = provider(key);
  const ctrl = new AbortController();
  const t0 = Date.now();
  const timeoutMs = TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const work = (async (): Promise<Result> => {
    try {
      // Non-streaming: one request/response. We only care about schema-valid
      // structured output + usage/latency, not token-by-token TTFT.
      const r = await generateObject({
        model: surplus(model),
        schema: TaskSchema,
        prompt: PROMPT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: ctrl.signal,
        providerOptions: {
          surplus: { reasoning: { effort: REASONING_EFFORT }, include_reasoning: true },
        },
      });

      const usage: any = r.usage;
      const duration = (Date.now() - t0) / 1000;
      const tokensIn = usage.inputTokens ?? 0;
      const tokensOut = usage.outputTokens ?? 0;
      const reasoningTokens =
        usage.outputTokenDetails?.reasoningTokens ??
        usage.raw?.completion_tokens_details?.reasoning_tokens ??
        0;
      const contentTokens = Math.max(0, tokensOut - reasoningTokens);
      const tokPerSec = duration > 0.3 ? Math.round(contentTokens / duration) : null;
      const costUSD = usage.raw?.cost ?? 0;
      const finishReason =
        (r as any).finishReason ??
        (r as any).response?.finishReason ??
        "stop";

      return {
        model,
        ok: true,
        jsonValid: true,
        error: null,
        failKind: null,
        rawPreview: null,
        finishReason: String(finishReason),
        ttft: null,
        duration: Math.round(duration * 10) / 10,
        tokensIn,
        tokensOut,
        reasoningTokens,
        thinking: reasoningTokens > 0,
        thinkingVisible: false,
        reasoningEffort: REASONING_EFFORT,
        tokPerSec,
        costUSD: Math.round(costUSD * 1e6) / 1e6,
      };
    } catch (e: any) {
      const aborted =
        ctrl.signal.aborted ||
        e?.name === "AbortError" ||
        String(e?.message ?? "").includes("aborted");
      if (aborted) {
        return failResult(model, t0, `timeout >${timeoutMs / 1000}s`, {
          finishReason: "timeout",
          failKind: "timeout",
        });
      }
      const d = diagnose(e);
      return failResult(model, t0, d.note, {
        finishReason: d.finishReason,
        failKind: d.failKind,
        rawPreview: d.rawPreview,
        tokensOut: d.tokensOut,
        reasoningTokens: d.reasoningTokens,
        costUSD: d.costUSD,
        thinking: d.reasoningTokens > 0,
      });
    }
  })();

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result>((resolve) => {
    graceTimer = setTimeout(() => {
      ctrl.abort();
      resolve(
        failResult(model, t0, `timeout >${timeoutMs / 1000}s`, {
          finishReason: "timeout",
          failKind: "timeout",
        }),
      );
    }, timeoutMs + 800);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

async function benchOne(model: string, key: string): Promise<Result> {
  return attempt(model, key);
}

export interface Run {
  at: number;
  results: Result[];
}

export async function runAll(
  key: string,
  onResult?: (result: Result, done: number, total: number) => void,
): Promise<Run> {
  const total = MODELS.length;
  let done = 0;
  const results = await Promise.all(
    MODELS.map(async (m) => {
      const result = await benchOne(m, key);
      done++;
      onResult?.(result, done, total);
      return result;
    }),
  );
  return { at: Date.now(), results };
}
