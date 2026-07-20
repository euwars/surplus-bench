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
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("model", 24), pad("json", 5), pad("think", 8), pad("tok/s", 7), pad("dur", 7), pad("out(r)", 12), "note");
  const t0 = Date.now();
  const run = await runAll(key, (r, done, total) => {
    console.log(
      pad(r.model, 24),
      pad(r.ok ? "OK" : "FAIL", 5),
      pad(r.thinking ? "yes" : "no", 8),
      pad(String(r.tokPerSec ?? "-"), 7),
      pad(r.duration + "s", 7),
      pad(`${r.tokensOut}(${r.reasoningTokens})`, 12),
      `${r.error ?? ""}  [${done}/${total} · ${((Date.now() - t0) / 1000).toFixed(1)}s]`,
    );
  });
  console.log(`\nrun @ ${new Date(run.at).toISOString()} · wall ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  // Force exit: hung marketplace sockets can keep the event loop alive even
  // after every attempt has timed out and results are printed.
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
