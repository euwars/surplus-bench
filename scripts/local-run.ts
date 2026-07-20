// Local run: one benchmark pass printed to the terminal — no server needed.
// Usage: SURPLUS_API_KEY=... npm run bench   (or it reads .env.local)
import { readFileSync } from "node:fs";
import { runAll } from "../lib/bench";

function loadEnv() {
  if (process.env.SURPLUS_API_KEY) return;
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^SURPLUS_API_KEY\s*=\s*(.+)$/);
      if (m) process.env.SURPLUS_API_KEY = m[1].trim();
    }
  } catch {}
}

async function main() {
  loadEnv();
  const key = process.env.SURPLUS_API_KEY;
  if (!key) throw new Error("SURPLUS_API_KEY not set (env or .env.local)");
  const run = await runAll(key);
  console.log(`\nrun @ ${new Date(run.at).toISOString()}\n`);
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("model", 24), pad("json", 5), pad("think", 12), pad("ttft", 7), pad("tok/s", 7), pad("dur", 7), pad("out(r)", 12), "note");
  for (const r of run.results) {
    const think = r.thinking ? (r.thinkingVisible ? "brain seen" : "brain hidden") : "none";
    console.log(
      pad(r.model, 24),
      pad(r.ok ? "OK" : "FAIL", 5),
      pad(think, 12),
      pad(r.ttft !== null ? r.ttft.toFixed(1) + "s" : "-", 7),
      pad(String(r.tokPerSec ?? "-"), 7),
      pad(r.duration + "s", 7),
      pad(`${r.tokensOut}(${r.reasoningTokens})`, 12),
      r.error ?? ""
    );
  }
  // Force exit: hung marketplace sockets can keep the event loop alive even
  // after every attempt has timed out and results are printed.
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
