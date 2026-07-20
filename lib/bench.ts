import { generateObject, NoObjectGeneratedError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  MODELS,
  SURPLUS_URL,
  PROMPT,
  SYSTEM,
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

type ModelRates = { prompt: number; completion: number; cacheRead: number };
let pricingCache: Map<string, ModelRates> | null = null;

/** Load $/token rates from Surplus /models — used when the completion body omits cost. */
async function loadPricing(key: string): Promise<Map<string, ModelRates>> {
  if (pricingCache) return pricingCache;
  const map = new Map<string, ModelRates>();
  try {
    const res = await fetch(`${SURPLUS_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    const data = (await res.json()) as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
    for (const m of data.data ?? []) {
      const p = m.pricing;
      if (!p) continue;
      map.set(m.id, {
        prompt: Number(p.prompt) || 0,
        completion: Number(p.completion) || 0,
        cacheRead: Number(p.input_cache_read) || Number(p.prompt) || 0,
      });
    }
  } catch {
    /* fall through with empty map */
  }
  pricingCache = map;
  return map;
}

/**
 * Surplus returns cost in several shapes:
 * - number on usage.cost (some sellers)
 * - { usd, diem } on the response root (many sellers leave usd=0 and put the
 *   real amount in diem — empirically matches published $/token × usage)
 */
function parseCostUSD(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (v && typeof v === "object") {
    const o = v as { usd?: unknown; diem?: unknown; cost?: unknown };
    if (typeof o.usd === "number" && Number.isFinite(o.usd) && o.usd > 0) return o.usd;
    if (typeof o.diem === "number" && Number.isFinite(o.diem) && o.diem > 0) return o.diem;
    if (typeof o.cost === "number" && Number.isFinite(o.cost) && o.cost > 0) return o.cost;
  }
  return null;
}

function estimateCostUSD(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheRead: number,
  rates: Map<string, ModelRates>,
): number | null {
  const r = rates.get(model);
  if (!r || (r.prompt <= 0 && r.completion <= 0)) return null;
  const cached = Math.min(Math.max(0, cacheRead), Math.max(0, tokensIn));
  const uncached = Math.max(0, tokensIn - cached);
  const usd = uncached * r.prompt + cached * r.cacheRead + Math.max(0, tokensOut) * r.completion;
  return usd > 0 ? usd : null;
}

/**
 * Prefer billed cost from the API, else estimate from published model rates × tokens.
 * Surplus often puts cost at the response root (not inside usage), which the AI SDK
 * drops unless we capture it via metadataExtractor.
 */
function resolveCostUSD(opts: {
  model: string;
  usage: any;
  providerMetadata?: any;
  rates: Map<string, ModelRates>;
}): number | null {
  const raw = opts.usage?.raw;
  const fromUsage = parseCostUSD(raw?.cost) ?? parseCostUSD(opts.usage?.cost);
  if (fromUsage != null) return fromUsage;

  const meta = opts.providerMetadata?.surplus ?? opts.providerMetadata;
  const fromMeta = parseCostUSD(meta?.cost);
  if (fromMeta != null) return fromMeta;

  const tokensIn =
    (typeof opts.usage?.inputTokens === "number" ? opts.usage.inputTokens : null) ??
    raw?.prompt_tokens ??
    0;
  const tokensOut =
    (typeof opts.usage?.outputTokens === "number" ? opts.usage.outputTokens : null) ??
    raw?.completion_tokens ??
    0;
  const cacheRead =
    opts.usage?.inputTokenDetails?.cacheReadTokens ??
    raw?.prompt_tokens_details?.cached_tokens ??
    0;
  return estimateCostUSD(opts.model, tokensIn, tokensOut, cacheRead, opts.rates);
}

function roundCost(usd: number | null): number {
  if (usd == null || !Number.isFinite(usd)) return 0;
  return Math.round(usd * 1e8) / 1e8; // 8 dp — tiny per-call costs need precision
}

// Pull top-level `cost` off Surplus responses into providerMetadata.surplus.
// Cast: Surplus cost shapes ({usd,diem} | number) aren't in SharedV4 JSONObject strictly.
const surplusMetadataExtractor = {
  async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
    const cost = (parsedBody as { cost?: unknown } | null)?.cost;
    if (cost == null) return undefined;
    return { surplus: { cost: cost as never } };
  },
  createStreamExtractor() {
    let cost: unknown;
    return {
      processChunk(parsedChunk: unknown) {
        const c = (parsedChunk as { cost?: unknown } | null)?.cost;
        if (c != null) cost = c;
      },
      buildMetadata() {
        if (cost == null) return undefined;
        return { surplus: { cost: cost as never } };
      },
    };
  },
};

function provider(key: string) {
  return createOpenAICompatible({
    name: "surplus",
    baseURL: SURPLUS_URL,
    apiKey: key,
    supportsStructuredOutputs: true,
    includeUsage: true,
    metadataExtractor: surplusMetadataExtractor as any,
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

/** First top-level `{...}` or `[...]` in text (handles trailing prose). */
function extractJsonValue(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Repair raw model text so valid-but-messy JSON counts as a pass:
 * markdown fences (```json ... ```), leading/trailing prose, etc.
 * Returns null if we can't recover parseable JSON (SDK will fail as before).
 */
async function repairText({ text }: { text: string; error: unknown }): Promise<string | null> {
  const raw = text.trim();
  if (!raw) return null;

  const candidates: string[] = [];
  const { body: unfenced } = stripMarkdownFence(raw);
  candidates.push(unfenced, raw);

  const extracted = extractJsonValue(unfenced) ?? extractJsonValue(raw);
  if (extracted) candidates.push(extracted);

  for (const c of candidates) {
    try {
      JSON.parse(c);
      // Prefer repaired text only when it differs from the raw (or is clean JSON).
      if (c !== raw || /^\s*[\[{]/.test(c)) return c;
    } catch {
      /* try next */
    }
  }
  return null;
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
      tokensOut: u.outputTokens ?? u.raw?.completion_tokens ?? 0,
      reasoningTokens,
      costUSD: roundCost(parseCostUSD(u.raw?.cost) ?? parseCostUSD(u.cost)),
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
      const zod = TaskSchema.safeParse(parsed);
      if (zod.success) {
        // Repair path should have accepted this; if we land here, treat as fence noise only.
        return {
          ...usage,
          failKind: "markdown_fence",
          note: fenced
            ? "valid schema object wrapped in markdown fence (should have been repaired)"
            : "valid schema object but SDK parse failed",
        };
      }
      const got = Object.keys(parsed as object);
      const expected = [...SCHEMA_KEYS];
      const missing = expected.filter((k) => !(k in (parsed as object)));
      const extra = got.filter((k) => !expected.includes(k as (typeof SCHEMA_KEYS)[number]));
      const parts: string[] = [];
      if (fenced) parts.push("markdown-fenced");
      parts.push("JSON failed schema");
      parts.push(`got {${got.join(", ") || "∅"}}`);
      parts.push(`need {${expected.join(", ")}}`);
      if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
      if (extra.length) parts.push(`extra: ${extra.join(", ")}`);
      // Surface first Zod issue for enums/types (e.g. stage: "Seed" vs "seed").
      const issue = zod.error.issues[0];
      if (issue) {
        parts.push(`${issue.path.join(".") || "root"}: ${issue.message}`);
      }
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
        system: SYSTEM,
        prompt: PROMPT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: ctrl.signal,
        providerOptions: {
          surplus: { reasoning: { effort: REASONING_EFFORT }, include_reasoning: true },
        },
        // Accept valid JSON that models wrap in ```json fences or a bit of prose.
        // Still fails if the unwrapped object doesn't match TaskSchema.
        experimental_repairText: repairText,
      });

      const usage: any = r.usage;
      const duration = (Date.now() - t0) / 1000;
      const tokensIn = usage.inputTokens ?? usage.raw?.prompt_tokens ?? 0;
      const tokensOut = usage.outputTokens ?? usage.raw?.completion_tokens ?? 0;
      const reasoningTokens =
        usage.outputTokenDetails?.reasoningTokens ??
        usage.raw?.completion_tokens_details?.reasoning_tokens ??
        0;
      const contentTokens = Math.max(0, tokensOut - reasoningTokens);
      const tokPerSec = duration > 0.3 ? Math.round(contentTokens / duration) : null;
      const rates = await loadPricing(key);
      const costUSD = roundCost(
        resolveCostUSD({
          model,
          usage,
          providerMetadata: (r as any).providerMetadata,
          rates,
        }),
      );
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
        costUSD,
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
      const rates = await loadPricing(key);
      const u: any = NoObjectGeneratedError.isInstance(e) ? (e as any).usage : null;
      const costUSD = roundCost(
        (d.costUSD > 0 ? d.costUSD : null) ??
          resolveCostUSD({ model, usage: u ?? { raw: null }, rates }),
      );
      return failResult(model, t0, d.note, {
        finishReason: d.finishReason,
        failKind: d.failKind,
        rawPreview: d.rawPreview,
        tokensIn: u?.inputTokens ?? u?.raw?.prompt_tokens ?? 0,
        tokensOut: d.tokensOut || (u?.outputTokens ?? 0),
        reasoningTokens: d.reasoningTokens,
        costUSD,
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
