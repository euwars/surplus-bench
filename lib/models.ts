// The models under test — edit this list to change what the harness benchmarks.
export const MODELS = [
  "kimi-k3",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
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

// Content + thinking budget. Half-size length targets keep content small;
// 20k still leaves headroom for Pro-class thinking.
export const MAX_OUTPUT_TOKENS = 20_000;

// Parallel per-model wall clock.
// Route maxDuration must exceed this (Vercel Pro+ for multi-minute).
export const TIMEOUT_MS = 90_000;

import { jsonSchema, type Schema } from "ai";
import { z } from "zod";

// ─── Source of truth: length policy ──────────────────────────────────────────
// Edit LENGTH / COUNTS only. TaskSchema, SYSTEM, PROMPT, and SCHEMA_KEYS are
// derived from them so prompt text and validation cannot drift.
//
// Units are characters (not tokens) — easy for models to follow and for us to
// enforce. min = hard Zod fail if short. max = soft target in the prompt only
// (we do not fail long answers; max caps verbosity so outputs finish complete).

type CharRange = { min: number; max: number };
type CountRange = { min: number; max: number };

/** Per-string character targets (~half the original payload). */
export const LENGTH = {
  company: { min: 1, max: 80 },
  executiveSummary: { min: 200, max: 350 },
  heading: { min: 3, max: 60 },
  analysis: { min: 120, max: 220 },
  bullet: { min: 20, max: 45 },
  title: { min: 3, max: 60 },
  detail: { min: 100, max: 180 },
  recommendation: { min: 40, max: 70 },
} as const satisfies Record<string, CharRange>;

/** Array item-count targets (~half). Prefer min===max so models do not over-produce. */
export const COUNTS = {
  sections: { min: 4, max: 4 },
  bullets: { min: 2, max: 2 },
  risks: { min: 3, max: 3 },
  recommendations: { min: 4, max: 4 },
} as const satisfies Record<string, CountRange>;

function zChars(range: CharRange) {
  // Only min is enforced. max is prompt guidance (see lengthTargetsText).
  return z.string().min(range.min);
}

/** Throughput-oriented structured task: force a large JSON payload so tok/s
 *  is measured over hundreds of content tokens, not a 40-token extraction. */
export const TaskSchema = z.object({
  company: zChars(LENGTH.company),
  stage: z.enum(["preSeed", "seed", "seriesA", "seriesB", "later"]),
  raiseUsd: z.number(),
  executiveSummary: zChars(LENGTH.executiveSummary),
  sections: z
    .array(
      z.object({
        heading: zChars(LENGTH.heading),
        analysis: zChars(LENGTH.analysis),
        bullets: z.array(zChars(LENGTH.bullet)).min(COUNTS.bullets.min),
      }),
    )
    .min(COUNTS.sections.min),
  risks: z
    .array(
      z.object({
        title: zChars(LENGTH.title),
        severity: z.enum(["low", "medium", "high"]),
        detail: zChars(LENGTH.detail),
      }),
    )
    .min(COUNTS.risks.min),
  recommendations: z
    .array(zChars(LENGTH.recommendation))
    .min(COUNTS.recommendations.min),
});

export type Task = z.infer<typeof TaskSchema>;

/** Expected top-level keys — used to diagnose "schema ignored" failures. */
export const SCHEMA_KEYS = Object.keys(TaskSchema.shape) as readonly (keyof Task)[];

/** Full JSON Schema for TaskSchema (includes minItems / minLength constraints). */
export const TaskJsonSchema = z.toJSONSchema(TaskSchema) as JsonSchemaNode;

// Brief is free-form prose, not part of the schema.
const COMPANY_BRIEF =
  "Convexity is an AI-native ERP for inventory-heavy mid-market distributors. " +
  "It layers AI agents onto existing ERPs (SAP, NetSuite) to automate purchasing. " +
  "Founder claims ~$130K ARR across 9 customers, a verified GreeneStep partnership, " +
  "and unverified BlueLink/Cubbo partnerships. Raising $1,000,000 at seed. " +
  "No corporate registration was found publicly. Revenue is founder-claimed only; CTO still employed at Microsoft.";

// ─── JSON Schema helpers ─────────────────────────────────────────────────────

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  required?: string[];
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchemaNode;
  description?: string;
  $schema?: string;
  [key: string]: unknown;
};

/**
 * OpenAI-compatible structured output (and Surplus marketplace sellers) only
 * accept array minItems of 0 or 1. Higher mins (e.g. .min(6) on risks) become
 * minItems: 6 and the request 400s:
 *   "For 'array' type, 'minItems' values other than 0 or 1 are not supported"
 *
 * We keep full mins on TaskSchema for local validation + the English prompt,
 * and send a clamped schema to the provider for constrained decoding.
 */
export function toProviderJsonSchema(node: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = { ...node };

  if (typeof out.minItems === "number" && out.minItems > 1) {
    out.minItems = 1;
  }

  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, toProviderJsonSchema(v)]),
    );
  }
  if (out.items) {
    out.items = Array.isArray(out.items)
      ? out.items.map(toProviderJsonSchema)
      : toProviderJsonSchema(out.items);
  }

  // Providers often choke on draft metadata.
  delete out.$schema;

  return out;
}

/**
 * AI SDK schema: provider gets a safe JSON Schema; parse still uses TaskSchema
 * so min lengths / array counts remain part of the pass/fail contract.
 */
export const TaskProviderSchema: Schema<Task> = jsonSchema<Task>(
  toProviderJsonSchema(TaskJsonSchema) as Parameters<typeof jsonSchema>[0],
  {
    validate(value) {
      const result = TaskSchema.safeParse(value);
      if (result.success) return { success: true as const, value: result.data };
      return { success: false as const, error: result.error };
    },
  },
);

// ─── Prompt text from LENGTH / COUNTS ────────────────────────────────────────

function charRange(r: CharRange): string {
  if (r.min <= 1 && r.max <= 1) return "non-empty string";
  if (r.min <= 1) return `string, up to ${r.max} chars`;
  if (r.min === r.max) return `string, exactly ~${r.min} chars`;
  return `string, ${r.min}–${r.max} chars`;
}

function countRange(r: CountRange, unit: string): string {
  if (r.min === r.max) return `exactly ${r.min} ${unit}`;
  return `${r.min}–${r.max} ${unit}`;
}

/**
 * Human-readable length targets (characters + item counts).
 * min is required for validation; max is a soft cap so models finish JSON.
 */
export function lengthTargetsText(): string {
  return (
    "Length targets (characters, not tokens — count letters/spaces/punctuation). " +
    "Meet every minimum or validation fails. Stay at or under each maximum so the " +
    "JSON completes fully; do not pad past the max.\n" +
    `- company: ${charRange(LENGTH.company)}\n` +
    `- stage: one of preSeed | seed | seriesA | seriesB | later\n` +
    `- raiseUsd: number (USD)\n` +
    `- executiveSummary: ${charRange(LENGTH.executiveSummary)} (1 short paragraph)\n` +
    `- sections: ${countRange(COUNTS.sections, "objects")}, each with:\n` +
    `    heading (${charRange(LENGTH.heading)})\n` +
    `    analysis (${charRange(LENGTH.analysis)}; a few sentences)\n` +
    `    bullets (${countRange(COUNTS.bullets, "strings")}, each ${LENGTH.bullet.min}–${LENGTH.bullet.max} chars)\n` +
    `- risks: ${countRange(COUNTS.risks, "objects")}, each with:\n` +
    `    title (${charRange(LENGTH.title)})\n` +
    `    severity (one of low | medium | high)\n` +
    `    detail (${charRange(LENGTH.detail)}; a few sentences)\n` +
    `- recommendations: ${countRange(COUNTS.recommendations, "strings")}, each ${LENGTH.recommendation.min}–${LENGTH.recommendation.max} chars`
  );
}

function buildSystemPrompt(keys: readonly string[]): string {
  return (
    "You are a JSON report API. " +
    "Respond with one JSON object only — no markdown, no ``` fences, no commentary. " +
    `Keys must be exactly: ${keys.join(", ")}. ` +
    "Never rename keys. Never wrap the object in a code block. " +
    "Hit the character and item-count targets in the user message — substantial but bounded; do not write endless prose."
  );
}

function buildUserPrompt(keys: readonly string[], brief: string): string {
  return (
    "Write a compact diligence report as a single raw JSON object (no markdown, no fences, no prose outside JSON). " +
    `Use exactly these camelCase keys: ${keys.join(", ")}. ` +
    "Do not invent alternate names. " +
    lengthTargetsText() +
    "\nGround the report in this company brief (expand with plausible diligence analysis; do not invent a different company):\n" +
    `"${brief}"`
  );
}

/** System instruction: strict output contract, separate from the user brief. */
export const SYSTEM = buildSystemPrompt(SCHEMA_KEYS);

/** User prompt — length targets generated from LENGTH / COUNTS. */
export const PROMPT = buildUserPrompt(SCHEMA_KEYS, COMPANY_BRIEF);
