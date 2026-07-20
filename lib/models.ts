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

import { z } from "zod";

// Throughput-oriented structured task: force a large JSON payload so tok/s
// is measured over hundreds of content tokens, not a 40-token extraction.
// Field names in SYSTEM/PROMPT must match TaskSchema keys exactly.

/** System instruction: strict output contract, separate from the user brief. */
export const SYSTEM =
  "You are a JSON report API. " +
  "Respond with one JSON object only — no markdown, no ``` fences, no commentary. " +
  "Keys must be exactly: company, stage, raiseUsd, executiveSummary, sections, risks, recommendations. " +
  "Never rename keys. Never wrap the object in a code block. " +
  "Write full sentences and long paragraphs so the report is substantial.";

export const PROMPT =
  "Write a long diligence report as a single raw JSON object (no markdown, no fences, no prose outside JSON). " +
  "Use exactly these camelCase keys: company, stage, raiseUsd, executiveSummary, sections, risks, recommendations. " +
  "Do not invent alternate names. " +
  "Requirements (meet every minimum — short answers fail validation):\n" +
  "- company: string\n" +
  "- stage: one of preSeed | seed | seriesA | seriesB | later\n" +
  "- raiseUsd: number (USD)\n" +
  "- executiveSummary: string, at least 400 characters, multi-paragraph\n" +
  "- sections: array of at least 8 objects, each with:\n" +
  "    heading (string), analysis (string ≥250 chars), bullets (array of ≥4 strings, each ≥40 chars)\n" +
  "- risks: array of at least 6 objects, each with:\n" +
  "    title (string), severity (low|medium|high), detail (string ≥200 chars)\n" +
  "- recommendations: array of at least 8 strings, each ≥80 chars\n" +
  "Ground the report in this company brief (expand with plausible diligence analysis; do not invent a different company):\n" +
  '"Convexity is an AI-native ERP for inventory-heavy mid-market distributors. ' +
  "It layers AI agents onto existing ERPs (SAP, NetSuite) to automate purchasing. " +
  "Founder claims ~$130K ARR across 9 customers, a verified GreeneStep partnership, " +
  "and unverified BlueLink/Cubbo partnerships. Raising $1,000,000 at seed. " +
  'No corporate registration was found publicly. Revenue is founder-claimed only; CTO still employed at Microsoft."';

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

// Expected top-level keys — used to diagnose "schema ignored" failures.
export const SCHEMA_KEYS = [
  "company",
  "stage",
  "raiseUsd",
  "executiveSummary",
  "sections",
  "risks",
  "recommendations",
] as const;
