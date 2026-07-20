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

// Generous output budget so a reasoning model never truncates before the JSON
// — that would be a false "could not parse". The findings payload is tiny; the
// headroom is for thinking tokens. You only pay for tokens actually used.
export const MAX_OUTPUT_TOKENS = 8000;

// Parallel per-model wall clock — dominates total run time. Two minutes so
// slow-but-capable models (kimi-k3, opus-4.8, gpt-5.6-sol-pro) get a real
// chance instead of a false timeout. NOTE: the run's function must be allowed
// to live this long — route maxDuration is 300s, which needs a Vercel plan
// above Hobby (Hobby caps functions at 60s → drop this to ~55s there).
export const TIMEOUT_MS = 120_000;

import { z } from "zod";

// A lean, near-deterministic extraction: the answer is embedded in the note, so
// every model should produce the SAME small object. That makes the benchmark
// about structured-output RELIABILITY and speed — not generation — with low
// token variance across models and runs. The schema still exercises the pieces
// weak sellers mishandle: an enum, a number, and an array.
//
// Prompt field names MUST match TaskSchema keys exactly. English paraphrases
// ("company name", "raise amount") train free-form sellers to invent
// company_name / raise_amount_usd and fail schema validation.
/** System instruction: strict output contract, separate from the user note. */
export const SYSTEM =
  "You are a JSON extraction API. " +
  "Respond with one JSON object only — no markdown, no ``` fences, no commentary. " +
  "Keys must be exactly: company (string), stage (preSeed|seed|seriesA|seriesB|later), " +
  "raiseUsd (number), risks (non-empty string array). " +
  "Never rename keys. Never wrap the object in a code block.";

export const PROMPT =
  "Extract from this note into the required JSON object. " +
  "Reply with raw JSON only (no markdown, no fences, no prose). " +
  "Use exactly these camelCase keys: company, stage, raiseUsd, risks. " +
  "Do not invent alternate names (e.g. company_name, raise_amount_usd, risk_flags). " +
  "Shape: " +
  '{"company":string,"stage":"preSeed"|"seed"|"seriesA"|"seriesB"|"later",' +
  '"raiseUsd":number,"risks":string[]}. ' +
  "stage must be one of those five enum values exactly. " +
  "Note: " +
  '"Convexity is an AI-native ERP raising $1,000,000 at the seed stage. ' +
  'Risks: revenue is unverified, and the CTO is still employed at Microsoft."';

export const TaskSchema = z.object({
  company: z.string(),
  stage: z.enum(["preSeed", "seed", "seriesA", "seriesB", "later"]),
  raiseUsd: z.number(),
  risks: z.array(z.string()).min(1),
});

// Expected top-level keys — used to diagnose "schema ignored" failures where
// sellers invent names instead of the schema keys.
export const SCHEMA_KEYS = ["company", "stage", "raiseUsd", "risks"] as const;
