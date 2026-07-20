import { streamObject } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { MODELS, SURPLUS_URL, PROMPT, FindingsSchema, REASONING_EFFORT } from "./models";

export interface Result {
  model: string;
  ok: boolean; // structured output produced and schema-valid
  jsonValid: boolean;
  error: string | null;
  ttft: number | null; // seconds to first streamed token
  duration: number; // seconds, total
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  thinking: boolean; // reasoned at all
  thinkingVisible: boolean; // reasoning was streamed to us
  reasoningEffort: string; // requested level (same across models)
  tokPerSec: number | null;
  costUSD: number; // real per-call cost from Surplus
}

const PER_MODEL_TIMEOUT_MS = 55_000;

function provider(key: string) {
  return createOpenAICompatible({
    name: "surplus",
    baseURL: SURPLUS_URL,
    apiKey: key,
    supportsStructuredOutputs: true,
    includeUsage: true,
  });
}

function failResult(
  model: string,
  t0: number,
  ttft: number | null,
  reasoningStreamed: boolean,
  error: string,
): Result {
  return {
    model,
    ok: false,
    jsonValid: false,
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
  };
}

async function attempt(model: string, key: string): Promise<Result> {
  const surplus = provider(key);
  const ctrl = new AbortController();
  const t0 = Date.now();
  let ttft: number | null = null;
  let reasoningStreamed = false;

  // Hard wall-clock race: even if the SDK/fetch ignores abortSignal (open
  // sockets, hung sellers), this attempt still settles so runAll can finish.
  const timeoutMs = PER_MODEL_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const work = (async (): Promise<Result> => {
    try {
      const r = streamObject({
        model: surplus(model),
        schema: FindingsSchema,
        prompt: PROMPT,
        // Reasoning models burn most of the budget on thinking; leave room
        // for the actual structured findings payload after that.
        maxOutputTokens: 4000,
        abortSignal: ctrl.signal,
        // Same reasoning effort for every model; sellers that can't reason
        // ignore it (recorded as no-thinking).
        providerOptions: {
          surplus: { reasoning: { effort: REASONING_EFFORT }, include_reasoning: true },
        },
        // Swallow stream errors here — we surface them via the throw below;
        // without this the SDK's error promise rejects unhandled and crashes.
        onError: () => {},
      });

      for await (const part of r.fullStream) {
        if (ctrl.signal.aborted) break;
        const type = (part as any).type as string;
        if (type.includes("reasoning")) reasoningStreamed = true;
        if (ttft === null && (type === "text-delta" || type === "object")) {
          ttft = (Date.now() - t0) / 1000;
        }
      }

      if (ctrl.signal.aborted) {
        return failResult(model, t0, ttft, reasoningStreamed, `timeout >${timeoutMs / 1000}s`);
      }

      await r.object; // throws if the model failed to produce a schema-valid object
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
        model, ok: true, jsonValid: true, error: null, ttft,
        duration: Math.round(duration * 10) / 10,
        tokensIn, tokensOut, reasoningTokens,
        thinking: reasoningTokens > 0 || reasoningStreamed,
        thinkingVisible: reasoningStreamed,
        reasoningEffort: REASONING_EFFORT,
        tokPerSec,
        costUSD: Math.round(costUSD * 1e6) / 1e6,
      };
    } catch (e: any) {
      const aborted = ctrl.signal.aborted
        || e?.name === "AbortError"
        || String(e?.message ?? "").includes("aborted");
      return failResult(
        model,
        t0,
        ttft,
        reasoningStreamed,
        aborted
          ? `timeout >${timeoutMs / 1000}s`
          : String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 140),
      );
    }
  })();

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result>((resolve) => {
    graceTimer = setTimeout(() => {
      ctrl.abort();
      resolve(failResult(model, t0, ttft, reasoningStreamed, `timeout >${timeoutMs / 1000}s`));
    }, timeoutMs + 1500); // small grace after abort
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

// One retry only for quick failures (marketplace 500s / earning-cap blips).
// Do not retry timeouts or long parse failures — that doubles wall time and
// blows the Vercel route maxDuration (60s).
async function benchOne(model: string, key: string): Promise<Result> {
  const first = await attempt(model, key);
  if (first.ok || first.error?.startsWith("timeout") || first.duration > 15) {
    return first;
  }
  const second = await attempt(model, key);
  return second.ok ? second : { ...second, error: `${second.error} (retried)` };
}

export interface Run {
  at: number;
  results: Result[];
}

export async function runAll(key: string): Promise<Run> {
  const results = await Promise.all(MODELS.map((m) => benchOne(m, key)));
  return { at: Date.now(), results };
}
