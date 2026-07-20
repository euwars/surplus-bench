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

// Requested for EVERY model so the comparison is apples-to-apples. Models that
// can't reason ignore it (recorded as no-thinking); reasoning models are held
// to the same effort. include_reasoning asks the seller to stream the thinking
// so we can measure whether it's visible.
export const REASONING_EFFORT: "low" | "medium" | "high" = "medium";

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

// The structured-output contract. The AI SDK validates the model's output
// against this — reliability = did generateObject/streamObject produce a
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
