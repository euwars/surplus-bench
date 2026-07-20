import { streamObject, NoObjectGeneratedError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  MODELS,
  SURPLUS_URL,
  PROMPT,
  TaskSchema,
  REASONING_EFFORT,
  MAX_OUTPUT_TOKENS,
  TIMEOUT_MS,
} from "./models";

export interface Result {
  model: string;
  ok: boolean; // structured output produced and schema-valid
  jsonValid: boolean;
  error: string | null;
  finishReason: string | null; // stop | length | error | ...
  ttft: number | null; // seconds to first streamed token
  duration: number; // seconds, total
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  thinking: boolean;
  thinkingVisible: boolean;
  reasoningEffort: string;
  tokPerSec: number | null;
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

// Pull real usage + text out of NoObjectGeneratedError so a failed row still
// shows WHY (truncated vs prose vs empty).
function diagnose(e: unknown): {
  finishReason: string | null;
  tokensOut: number;
  reasoningTokens: number;
  costUSD: number;
  note: string;
} {
  if (NoObjectGeneratedError.isInstance(e)) {
    const u: any = e.usage ?? {};
    const reasoningTokens =
      u.outputTokenDetails?.reasoningTokens ??
      u.raw?.completion_tokens_details?.reasoning_tokens ??
      0;
    const text = (e.text ?? "").trim();
    const fr = (e.finishReason as string | undefined) ?? null;
    const note =
      fr === "length"
        ? `truncated at ${MAX_OUTPUT_TOKENS} tok (thought ${reasoningTokens}, no JSON left)`
        : text
          ? `non-JSON: ${text.replace(/\s+/g, " ").slice(0, 70)}`
          : "empty / refusal";
    return {
      finishReason: fr,
      tokensOut: u.outputTokens ?? 0,
      reasoningTokens,
      costUSD: Math.round((u.raw?.cost ?? 0) * 1e6) / 1e6,
      note,
    };
  }
  return {
    finishReason: null,
    tokensOut: 0,
    reasoningTokens: 0,
    costUSD: 0,
    note: String((e as any)?.message ?? e).replace(/\s+/g, " ").slice(0, 140),
  };
}

function failResult(
  model: string,
  t0: number,
  ttft: number | null,
  reasoningStreamed: boolean,
  error: string,
  extra?: Partial<Result>,
): Result {
  return {
    model,
    ok: false,
    jsonValid: false,
    finishReason: null,
    ttft,
    thinking: reasoningStreamed,
    thinkingVisible: reasoningStreamed,
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
  let ttft: number | null = null;
  let reasoningStreamed = false;
  let finishReason: string | null = null;

  const timeoutMs = TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const work = (async (): Promise<Result> => {
    try {
      const r = streamObject({
        model: surplus(model),
        schema: TaskSchema,
        prompt: PROMPT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: ctrl.signal,
        providerOptions: {
          surplus: { reasoning: { effort: REASONING_EFFORT }, include_reasoning: true },
        },
        onError: () => {},
      });

      for await (const part of r.fullStream) {
        if (ctrl.signal.aborted) break;
        const type = (part as { type: string }).type;
        if (type.includes("reasoning")) reasoningStreamed = true;
        if (type === "finish") {
          finishReason = (part as { finishReason?: string }).finishReason ?? finishReason;
        }
        if (ttft === null && (type === "text-delta" || type === "object")) {
          ttft = (Date.now() - t0) / 1000;
        }
      }

      if (ctrl.signal.aborted) {
        return failResult(model, t0, ttft, reasoningStreamed, `timeout >${timeoutMs / 1000}s`, {
          finishReason: "timeout",
        });
      }

      await r.object;
      const usage: any = await r.usage;
      const duration = (Date.now() - t0) / 1000;

      const tokensIn = usage.inputTokens ?? 0;
      const tokensOut = usage.outputTokens ?? 0;
      const reasoningTokens =
        usage.outputTokenDetails?.reasoningTokens ??
        usage.raw?.completion_tokens_details?.reasoning_tokens ??
        0;
      const contentTokens = Math.max(0, tokensOut - reasoningTokens);
      const genWindow = ttft !== null && duration > ttft ? duration - ttft : duration;
      const tokPerSec = genWindow > 0.3 ? Math.round(contentTokens / genWindow) : null;
      const costUSD = usage.raw?.cost ?? 0;

      return {
        model,
        ok: true,
        jsonValid: true,
        error: null,
        finishReason: finishReason ?? "stop",
        ttft,
        duration: Math.round(duration * 10) / 10,
        tokensIn,
        tokensOut,
        reasoningTokens,
        thinking: reasoningTokens > 0 || reasoningStreamed,
        thinkingVisible: reasoningStreamed,
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
        return failResult(model, t0, ttft, reasoningStreamed, `timeout >${timeoutMs / 1000}s`, {
          finishReason: "timeout",
        });
      }
      const d = diagnose(e);
      return failResult(model, t0, ttft, reasoningStreamed, d.note, {
        finishReason: d.finishReason,
        tokensOut: d.tokensOut,
        reasoningTokens: d.reasoningTokens,
        costUSD: d.costUSD,
        thinking: d.reasoningTokens > 0 || reasoningStreamed,
      });
    }
  })();

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result>((resolve) => {
    graceTimer = setTimeout(() => {
      ctrl.abort();
      resolve(
        failResult(model, t0, ttft, reasoningStreamed, `timeout >${timeoutMs / 1000}s`, {
          finishReason: "timeout",
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

// No retries — next cron/manual run is the re-check. Retries doubled wall time.
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
