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

// Long structured report: need room for ~1–2k content tokens plus thinking.
export const MAX_OUTPUT_TOKENS = 8000;

// Parallel per-model wall clock. Longer generation needs more headroom.
// Route maxDuration must exceed this (Vercel Pro+ for multi-minute).
export const TIMEOUT_MS = 180_000;

import { jsonSchema, type Schema } from "ai";
import { z } from "zod";

// ─── Source of truth ─────────────────────────────────────────────────────────
// Edit TaskSchema only. SYSTEM, PROMPT, SCHEMA_KEYS, and the provider JSON
// schema are derived from it so prompt text and validation cannot drift.

/** Throughput-oriented structured task: force a large JSON payload so tok/s
 *  is measured over hundreds of content tokens, not a 40-token extraction. */
export const TaskSchema = z.object({
  company: z.string().min(1),
  stage: z.enum(["preSeed", "seed", "seriesA", "seriesB", "later"]),
  raiseUsd: z.number(),
  executiveSummary: z.string().min(400),
  sections: z
    .array(
      z.object({
        heading: z.string().min(3),
        analysis: z.string().min(250),
        bullets: z.array(z.string().min(40)).min(4),
      }),
    )
    .min(8),
  risks: z
    .array(
      z.object({
        title: z.string().min(3),
        severity: z.enum(["low", "medium", "high"]),
        detail: z.string().min(200),
      }),
    )
    .min(6),
  recommendations: z.array(z.string().min(80)).min(8),
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
  if (typeof out.maxItems === "number" && out.maxItems > 1) {
    // Keep maxItems only if providers tolerate it; strip if we see failures.
    // Currently leave as-is — the 400 we hit is minItems-only.
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

// ─── Prompt text derived from TaskJsonSchema ─────────────────────────────────

/** Compact human type line for a single JSON-schema node (not nested objects). */
function typeLabel(node: JsonSchemaNode): string {
  const t = Array.isArray(node.type) ? node.type.join("|") : node.type;
  if (node.enum?.length) {
    return `one of ${node.enum.map((v) => String(v)).join(" | ")}`;
  }
  if (t === "array" && node.items && !Array.isArray(node.items)) {
    const item = node.items;
    const minN = typeof node.minItems === "number" ? node.minItems : null;
    const minPrefix =
      minN != null ? `array of at least ${minN}` : "array";
    if (item.enum?.length) {
      return `${minPrefix} of enum (${item.enum.map(String).join(" | ")})`;
    }
    if (item.type === "string") {
      const each =
        typeof item.minLength === "number" && item.minLength > 1
          ? `, each ≥${item.minLength} chars`
          : "";
      return `${minPrefix} strings${each}`;
    }
    if (item.type === "number" || item.type === "integer") {
      return `${minPrefix} ${item.type === "integer" ? "integers" : "numbers"}`;
    }
    if (item.type === "object" && item.properties) {
      const fields = Object.entries(item.properties).map(
        ([k, v]) => `${k} (${typeLabel(v)})`,
      );
      return `${minPrefix} objects, each with: ${fields.join(", ")}`;
    }
    return `${minPrefix} items (${typeLabel(item)})`;
  }
  if (t === "string") {
    if (typeof node.minLength === "number" && node.minLength > 1) {
      return `string ≥${node.minLength} chars`;
    }
    if (node.minLength === 1) return "non-empty string";
    return "string";
  }
  if (t === "number" || t === "integer") {
    const bits: string[] = [t === "integer" ? "integer" : "number"];
    if (typeof node.minimum === "number") bits.push(`≥${node.minimum}`);
    if (typeof node.maximum === "number") bits.push(`≤${node.maximum}`);
    return bits.join(" ");
  }
  if (t === "boolean") return "boolean";
  if (t === "object") return "object";
  return t ?? "value";
}

function describeNode(node: JsonSchemaNode, indent = ""): string {
  if (node.type !== "object" || !node.properties) return typeLabel(node);

  return Object.entries(node.properties)
    .map(([k, child]) => {
      // Nested array-of-objects: expand fields on following lines (readable for prompts).
      if (
        child.type === "array" &&
        child.items &&
        !Array.isArray(child.items) &&
        child.items.type === "object" &&
        child.items.properties
      ) {
        const minN = typeof child.minItems === "number" ? child.minItems : null;
        const head =
          minN != null
            ? `array of at least ${minN} objects, each with:`
            : "array of objects, each with:";
        const fieldLines = Object.entries(child.items.properties).map(
          ([fk, fv]) => `${indent}    ${fk} (${typeLabel(fv)})`,
        );
        return `${indent}- ${k}: ${head}\n${fieldLines.join("\n")}`;
      }
      return `${indent}- ${k}: ${typeLabel(child)}`;
    })
    .join("\n");
}

/** Human-readable field requirements, always in sync with TaskSchema. */
export function schemaRequirementsText(schema: JsonSchemaNode = TaskJsonSchema): string {
  return (
    "Requirements (meet every minimum — short answers fail validation):\n" +
    describeNode(schema)
  );
}

function buildSystemPrompt(keys: readonly string[]): string {
  return (
    "You are a JSON report API. " +
    "Respond with one JSON object only — no markdown, no ``` fences, no commentary. " +
    `Keys must be exactly: ${keys.join(", ")}. ` +
    "Never rename keys. Never wrap the object in a code block. " +
    "Write full sentences and long paragraphs so the report is substantial."
  );
}

function buildUserPrompt(schema: JsonSchemaNode, keys: readonly string[], brief: string): string {
  return (
    "Write a long diligence report as a single raw JSON object (no markdown, no fences, no prose outside JSON). " +
    `Use exactly these camelCase keys: ${keys.join(", ")}. ` +
    "Do not invent alternate names. " +
    schemaRequirementsText(schema) +
    "\nGround the report in this company brief (expand with plausible diligence analysis; do not invent a different company):\n" +
    `"${brief}"`
  );
}

/** System instruction: strict output contract, separate from the user brief. */
export const SYSTEM = buildSystemPrompt(SCHEMA_KEYS);

/** User prompt — requirements block is generated from TaskSchema. */
export const PROMPT = buildUserPrompt(TaskJsonSchema, SCHEMA_KEYS, COMPANY_BRIEF);
