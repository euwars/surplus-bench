"use client";
import { useEffect, useMemo, useState } from "react";

interface Result {
  model: string;
  ok: boolean;
  jsonValid: boolean;
  error: string | null;
  ttft: number | null;
  duration: number;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  thinking: boolean;
  thinkingVisible: boolean;
  reasoningEffort: string;
  tokPerSec: number | null;
  costUSD: number;
}
interface Run { at: number; results: Result[]; }
interface Data { latest: Run | null; history: Run[]; persistent: boolean; now: number; }

const STALE_MS = 10 * 60 * 1000;

export default function Page() {
  const [data, setData] = useState<Data | null>(null);
  const [running, setRunning] = useState(false);

  async function load() {
    const r = await fetch("/api/data", { cache: "no-store" });
    setData(await r.json());
  }
  async function trigger() {
    if (running) return;
    setRunning(true);
    try { await fetch("/api/run", { cache: "no-store" }); } finally { setRunning(false); load(); }
  }

  useEffect(() => { load(); }, []);
  // On first load with no/stale data, kick a run immediately.
  useEffect(() => {
    if (!data) return;
    const age = data.latest ? data.now - data.latest.at : Infinity;
    if (age > STALE_MS && !running) trigger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  // Poll for fresh data every 20s.
  useEffect(() => { const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);

  const models = useMemo(() => {
    if (!data?.latest) return [];
    return data.latest.results.map((r) => r.model);
  }, [data]);

  // Per-model reliability over history (fraction of runs where JSON was valid).
  const reliability = useMemo(() => {
    if (!data) return {};
    const out: Record<string, { total: number; ok: number }> = {};
    for (const run of data.history) {
      for (const r of run.results) {
        out[r.model] ??= { total: 0, ok: 0 };
        out[r.model].total++;
        if (r.ok) out[r.model].ok++;
      }
    }
    return out;
  }, [data]);

  const age = data?.latest ? Math.round((data.now - data.latest.at) / 1000) : null;

  return (
    <main>
      <header>
        <h1>Surplus model benchmark</h1>
        <div className="status">
          {data ? (
            <>
              <span className={running ? "dot live" : "dot"} />
              {running ? "running…" : age === null ? "no data yet" : `updated ${fmtAge(age)} ago`}
              {" · "}{data.history.length} runs
              {data.latest?.results[0]?.reasoningEffort ? ` · reasoning: ${data.latest.results[0].reasoningEffort} (same for all)` : ""}
              {" · "}{data.persistent ? "persistent" : "in-memory (add Vercel KV for history)"}
              <button onClick={trigger} disabled={running}>Run now</button>
            </>
          ) : "loading…"}
        </div>
      </header>

      {!data?.latest && !running && (
        <p className="empty">No runs yet — a benchmark starts automatically. This first pass takes up to a minute.</p>
      )}

      {data?.latest && (
        <table>
          <thead>
            <tr>
              <th>Model</th><th>JSON</th><th>think</th><th>first tok</th><th>tok/s</th>
              <th>duration</th><th>out (reason)</th><th>cost</th><th>reliability</th><th>note</th>
            </tr>
          </thead>
          <tbody>
            {data.latest.results.map((r) => {
              const rel = reliability[r.model];
              const pct = rel && rel.total ? Math.round((100 * rel.ok) / rel.total) : null;
              return (
                <tr key={r.model} className={r.ok ? "" : "fail"}>
                  <td className="model">{r.model}</td>
                  <td>{r.ok ? <span className="ok">✓</span> : <span className="x">✗</span>}</td>
                  <td className="think">
                    {r.thinking
                      ? (r.thinkingVisible ? <span title="reasons, thinking visible">🧠 seen</span>
                                           : <span title="reasons, thinking hidden">🧠 hidden</span>)
                      : <span className="none" title="no reasoning">—</span>}
                  </td>
                  <td>{r.ttft !== null ? `${r.ttft.toFixed(1)}s` : "—"}</td>
                  <td>{r.tokPerSec ?? "—"}</td>
                  <td>{r.duration.toFixed(1)}s</td>
                  <td>{r.tokensOut}{r.reasoningTokens ? ` (${r.reasoningTokens})` : ""}</td>
                  <td>{r.costUSD ? `$${r.costUSD.toFixed(4)}` : "—"}</td>
                  <td>
                    {pct !== null ? (
                      <span className="rel">
                        <span className="bar"><span style={{ width: `${pct}%` }} className={pct >= 90 ? "g" : pct >= 60 ? "y" : "r"} /></span>
                        {pct}%
                      </span>
                    ) : "—"}
                  </td>
                  <td className="note">{r.error ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {data && data.history.length > 1 && (
        <section className="charts">
          <h2>JSON reliability over time</h2>
          <div className="grid">
            {models.map((m) => (
              <Spark key={m} model={m} history={data.history} />
            ))}
          </div>
        </section>
      )}

      <style jsx global>{`
        * { box-sizing: border-box; }
        body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
          background: #0b0d10; color: #d8dee9; }
        main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        h2 { font-size: 13px; color: #8a94a6; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: .05em; }
        header { border-bottom: 1px solid #1c2128; padding-bottom: 12px; margin-bottom: 16px; }
        .status { color: #8a94a6; font-size: 13px; display: flex; align-items: center; gap: 8px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #3a4151; display: inline-block; }
        .dot.live { background: #4ade80; animation: pulse 1s infinite; }
        @keyframes pulse { 50% { opacity: .3; } }
        button { margin-left: auto; background: #1c2430; color: #d8dee9; border: 1px solid #2b3444;
          padding: 4px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px; }
        button:disabled { opacity: .5; cursor: default; }
        .empty { color: #8a94a6; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { text-align: left; color: #6b7280; font-weight: 500; padding: 6px 10px; border-bottom: 1px solid #1c2128; }
        td { padding: 7px 10px; border-bottom: 1px solid #14181e; }
        tr.fail td.model { color: #f87171; }
        .model { font-weight: 600; }
        .ok { color: #4ade80; } .x { color: #f87171; }
        .note { color: #6b7280; font-size: 11px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rel { display: flex; align-items: center; gap: 6px; }
        .bar { width: 54px; height: 6px; background: #1c2128; border-radius: 3px; overflow: hidden; display: inline-block; }
        .bar span { display: block; height: 100%; }
        .bar .g { background: #4ade80; } .bar .y { background: #fbbf24; } .bar .r { background: #f87171; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
        .spark { border: 1px solid #1c2128; border-radius: 8px; padding: 10px; }
        .spark .name { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
      `}</style>
    </main>
  );
}

function Spark({ model, history }: { model: string; history: Run[] }) {
  // Oldest → newest, 1 = valid JSON, 0 = fail. Green bars pass, red fail.
  const series = [...history].reverse().map((run) => {
    const r = run.results.find((x) => x.model === model);
    return r ? (r.ok ? 1 : 0) : -1;
  });
  const w = 190, h = 34, n = series.length, bw = n ? w / n : w;
  const okCount = series.filter((v) => v === 1).length;
  const total = series.filter((v) => v >= 0).length;
  return (
    <div className="spark">
      <div className="name">{model} · {total ? Math.round((100 * okCount) / total) : 0}%</div>
      <svg width={w} height={h}>
        {series.map((v, i) => (
          <rect key={i} x={i * bw} y={v === 1 ? h * 0.15 : h * 0.5} width={Math.max(1, bw - 1)}
            height={v === 1 ? h * 0.85 : h * 0.5}
            fill={v === 1 ? "#4ade80" : v === 0 ? "#f87171" : "#2b3444"} />
        ))}
      </svg>
    </div>
  );
}

function fmtAge(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
