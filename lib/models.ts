// The models under test — edit this list to change what the harness benchmarks.
export const MODELS = [
  "glm-5.2",
  "kimi-k3",
  "gpt-5.4",
  "gemini-3.1-pro-preview",
  "gpt-5.6-sol-pro",
  "claude-opus-4.8",
  "claude-sonnet-5",
  "gpt-5.5",
  "gemini-3-5-flash",
  "grok-4.5",
];

export const SURPLUS_URL = "https://api.surplusintelligence.ai/v1";

// Same effort for every model. "low" is the fast path for frequent updates —
// still apples-to-apples, much less thinking-token burn before JSON.
export const REASONING_EFFORT: "low" | "medium" | "high" = "low";

// Lean output budget: findings JSON is small; low effort needs less headroom.
export const MAX_OUTPUT_TOKENS = 1600;

// Parallel per-model wall clock — dominates total run time. Two minutes so
// slow-but-capable models (kimi-k3, opus-4.8, gpt-5.6-sol-pro) get a real
// chance instead of a false timeout. NOTE: the run's function must be allowed
// to live this long — route maxDuration is 300s, which needs a Vercel plan
// above Hobby (Hobby caps functions at 60s → drop this to ~55s there).
export const TIMEOUT_MS = 120_000;

// One prompt, identical for every model, that demands real structured output.
export const PROMPT =
  "You are a diligence analyst. Company: Convexity, an AI-native ERP for " +
  "inventory-heavy mid-market distributors. It layers AI agents onto existing " +
  "ERPs (SAP, NetSuite) to automate purchasing. Founder claims ~$130K ARR " +
  "across 9 customers, a verified GreeneStep partnership, and unverified " +
  "BlueLink/Cubbo partnerships. No corporate registration was found publicly. " +
  "Produce up to 5 diligence findings. Each finding: a claim, a status " +
  "(established | claimedOnly | contradicted | notFound), one line of evidence, " +
  "and a source.";

import { z } from "zod";

// The structured-output contract. Reliability = did streamObject produce a
// conformant object (exact fields, valid enum, non-empty findings).
export const FindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        claim: z.string(),
        status: z.enum(["established", "claimedOnly", "contradicted", "notFound"]),
        evidence: z.string(),
        source: z.string(),
      })
    )
    .min(1),
});
