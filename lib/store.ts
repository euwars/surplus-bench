import type { Run } from "./bench";

// Persistence with graceful fallback: Vercel KV when its env is present
// (survives across serverless instances → real history), else an in-process
// array (works locally and on a warm instance). Add a Vercel KV store to the
// project for durable history; nothing else needs configuring.
const HISTORY_KEY = "surplus-bench:history";
const MAX = 200; // cap history length

const hasKV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
let memory: Run[] = [];

async function kv() {
  const mod = await import("@vercel/kv");
  return mod.kv;
}

export async function saveRun(run: Run): Promise<void> {
  if (hasKV) {
    const k = await kv();
    await k.lpush(HISTORY_KEY, run);
    await k.ltrim(HISTORY_KEY, 0, MAX - 1);
  } else {
    memory.unshift(run);
    memory = memory.slice(0, MAX);
  }
}

export async function getHistory(limit = 60): Promise<Run[]> {
  if (hasKV) {
    const k = await kv();
    return ((await k.lrange(HISTORY_KEY, 0, limit - 1)) as Run[]) ?? [];
  }
  return memory.slice(0, limit);
}

export async function getLatest(): Promise<Run | null> {
  return (await getHistory(1))[0] ?? null;
}

export const persistent = hasKV;
