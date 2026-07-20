"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MODELS, REASONING_EFFORT } from "@/lib/models";

interface Result {
  model: string;
  ok: boolean;
  jsonValid: boolean;
  error: string | null;
  failKind?: string | null;
  rawPreview?: string | null;
  finishReason?: string | null;
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

const FAIL_KIND_LABEL: Record<string, string> = {
  schema_mismatch: "Wrong shape",
  markdown_fence: "Fenced JSON",
  prose: "Prose",
  truncated: "Truncated",
  timeout: "Timeout",
  empty: "Empty",
  parse_error: "Bad JSON",
  error: "Error",
};
interface Run {
  at: number;
  startedAt?: number;
  source?: "cron" | "manual" | "cli";
  results: Result[];
}
interface Data {
  latest: Run | null;
  history: Run[];
  persistent: boolean;
  now: number;
}

type LiveStatus = "queued" | "running" | "done";

type SortKey =
  | "model"
  | "status"
  | "think"
  | "tokPerSec"
  | "duration"
  | "tokensOut"
  | "cost"
  | "reliability"
  | "note";

type SortDir = "asc" | "desc";

const SORT_COLUMNS: { key: SortKey; label: string; align?: "left" | "right" }[] = [
  { key: "model", label: "Model" },
  { key: "status", label: "Status" },
  { key: "think", label: "Think" },
  { key: "tokPerSec", label: "Tok/s", align: "right" },
  { key: "duration", label: "Duration", align: "right" },
  { key: "tokensOut", label: "Out (reason)", align: "right" },
  { key: "cost", label: "Cost", align: "right" },
  { key: "reliability", label: "Reliability" },
  { key: "note", label: "Note" },
];

/** Default: numbers/bools desc first; strings asc first. */
const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  model: "asc",
  status: "asc",
  think: "desc",
  tokPerSec: "desc",
  duration: "asc",
  tokensOut: "desc",
  cost: "asc",
  reliability: "desc",
  note: "asc",
};

type LiveRow = {
  model: string;
  status: LiveStatus;
  result: Result | null;
  /** previous result shown while this model is still running */
  previous: Result | null;
};

type ProgressEvent =
  | { type: "start"; models: string[]; at: number; reasoningEffort: string }
  | { type: "result"; result: Result; done: number; total: number }
  | { type: "done"; run: Run }
  | { type: "skipped"; run: Run }
  | { type: "error"; error: string };

export default function Page() {
  const [data, setData] = useState<Data | null>(null);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<LiveRow[] | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: MODELS.length });
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("model");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const runningRef = useRef(false);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDir(SORT_DEFAULT_DIR[key]);
      return key;
    });
  }, []);

  const load = useCallback(async () => {
    const r = await fetch("/api/data", { cache: "no-store" });
    setData(await r.json());
  }, []);

  const trigger = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setRunError(null);
    setRunStartedAt(Date.now());
    setElapsed(0);
    setProgress({ done: 0, total: MODELS.length });

    // Seed live rows from previous results (if any) so the table stays useful.
    const prevByModel = new Map(
      (data?.latest?.results ?? []).map((r) => [r.model, r] as const),
    );
    setLive(
      MODELS.map((model) => ({
        model,
        status: "running" as const,
        result: null,
        previous: prevByModel.get(model) ?? null,
      })),
    );

    try {
      // POST = explicit manual run. Cron uses GET and is not kicked from the UI.
      const res = await fetch("/api/run", { method: "POST", cache: "no-store" });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Run failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ProgressEvent;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          handleEvent(event);
        }
      }
      if (buf.trim()) {
        try {
          handleEvent(JSON.parse(buf) as ProgressEvent);
        } catch {
          /* ignore trailing partial */
        }
      }
    } catch (e: any) {
      setRunError(String(e?.message ?? e).slice(0, 2000));
    } finally {
      runningRef.current = false;
      setRunning(false);
      setRunStartedAt(null);
      await load();
      // Clear live overlay after data refresh so we show stored latest cleanly.
      setLive(null);
    }

    function handleEvent(event: ProgressEvent) {
      if (event.type === "start") {
        setProgress({ done: 0, total: event.models.length });
        setLive(
          event.models.map((model) => ({
            model,
            status: "running" as const,
            result: null,
            previous: prevByModel.get(model) ?? null,
          })),
        );
      } else if (event.type === "result") {
        setProgress({ done: event.done, total: event.total });
        setLive((rows) =>
          (rows ?? []).map((row) =>
            row.model === event.result.model
              ? { ...row, status: "done", result: event.result }
              : row,
          ),
        );
      } else if (event.type === "done") {
        setProgress({ done: event.run.results.length, total: event.run.results.length });
        setLive(
          event.run.results.map((result) => ({
            model: result.model,
            status: "done" as const,
            result,
            previous: null,
          })),
        );
      } else if (event.type === "skipped") {
        setProgress({
          done: event.run.results.length,
          total: event.run.results.length,
        });
        setLive(
          event.run.results.map((result) => ({
            model: result.model,
            status: "done" as const,
            result,
            previous: null,
          })),
        );
      } else if (event.type === "error") {
        setRunError(event.error);
      }
    }
  }, [data, load]);

  useEffect(() => {
    load();
  }, [load]);

  // No auto-run on stale/missing data — only Vercel cron (GET) or "Run now" (POST).

  // Tick elapsed while running.
  useEffect(() => {
    if (!running || runStartedAt === null) return;
    const tick = () => setElapsed(Math.round((Date.now() - runStartedAt) / 100) / 10);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [running, runStartedAt]);

  // Background poll only when idle (live stream owns the active run).
  useEffect(() => {
    if (running) return;
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [running, load]);

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

  // Prefer live rows while a run is active; otherwise stored latest.
  const displayRows: LiveRow[] = useMemo(() => {
    if (live) return live;
    if (data?.latest) {
      return data.latest.results.map((result) => ({
        model: result.model,
        status: "done" as const,
        result,
        previous: null,
      }));
    }
    return MODELS.map((model) => ({
      model,
      status: "queued" as const,
      result: null,
      previous: null,
    }));
  }, [live, data]);

  const sortedRows: LiveRow[] = useMemo(() => {
    const statusRank = (row: LiveRow) => {
      if (row.status === "running") return 1;
      if (row.status === "queued") return 2;
      if (row.result?.ok) return 0; // pass first on asc
      return 3; // fail
    };

    const valueOf = (row: LiveRow): string | number | null => {
      const r = row.result ?? row.previous;
      const rel = reliability[row.model];
      switch (sortKey) {
        case "model":
          return row.model.toLowerCase();
        case "status":
          return statusRank(row);
        case "think":
          return r?.thinking ? 1 : 0;
        case "tokPerSec":
          return r?.tokPerSec ?? null;
        case "duration":
          return r?.duration ?? null;
        case "tokensOut":
          return r?.tokensOut ?? null;
        case "cost":
          return r?.costUSD ?? null;
        case "reliability":
          return rel && rel.total ? rel.ok / rel.total : null;
        case "note":
          return (row.status === "running" ? "in flight" : (row.result?.error ?? "")).toLowerCase();
        default:
          return null;
      }
    };

    const dir = sortDir === "asc" ? 1 : -1;
    return [...displayRows].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      // Missing values always last, regardless of direction.
      if (va == null && vb == null) return a.model.localeCompare(b.model);
      if (va == null) return 1;
      if (vb == null) return -1;
      let cmp = 0;
      if (typeof va === "string" && typeof vb === "string") cmp = va.localeCompare(vb);
      else cmp = (va as number) - (vb as number);
      if (cmp !== 0) return cmp * dir;
      return a.model.localeCompare(b.model);
    });
  }, [displayRows, sortKey, sortDir, reliability]);

  const models = displayRows.map((r) => r.model);
  const age = data?.latest ? Math.round((data.now - data.latest.at) / 1000) : null;
  const doneResults = displayRows.filter((r) => r.status === "done" && r.result);
  const livePass = doneResults.filter((r) => r.result!.ok).length;
  const liveFail = doneResults.filter((r) => r.result && !r.result.ok).length;
  const stillGoing = displayRows.filter((r) => r.status === "running").length;
  const pctDone =
    progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0;
  const effort =
    displayRows.find((r) => r.result)?.result?.reasoningEffort ?? REASONING_EFFORT;

  return (
    <main className="page">
      <div className="shell">
        <header className="hero">
          <div className="hero-text">
            <p className="eyebrow">Surplus · structured output</p>
            <h1>Model benchmark</h1>
            <p className="lede">
              Compact structured diligence report (same prompt +{" "}
              <code className="inline-code">json_schema</code> for every model) so tok/s is measured
              over a real JSON payload — not a tiny extraction. Fail usually means the seller
              ignored strict schema, not that the model “is dumb.”
            </p>
          </div>
          <button className="btn-primary" onClick={() => trigger()} disabled={running}>
            {running ? (
              <>
                <span className="spinner" />
                {progress.done}/{progress.total}
              </>
            ) : (
              "Run now"
            )}
          </button>
        </header>

        <div className="meta">
          {!data ? (
            <span className="muted">Loading…</span>
          ) : (
            <>
              <span className={`pill ${running ? "pill-live" : "pill-idle"}`}>
                <span className={`dot ${running ? "live" : ""}`} />
                {running
                  ? `Running · ${elapsed.toFixed(1)}s`
                  : age === null
                    ? "No data · click Run now or wait for cron"
                    : `Updated ${fmtAge(age)} ago`}
              </span>
              {!running && data?.latest?.source && (
                <span className="pill muted-pill">via {data.latest.source}</span>
              )}
              {running ? (
                <>
                  <span className="pill">
                    <strong>
                      {progress.done}/{progress.total}
                    </strong>{" "}
                    done
                  </span>
                  <span className="pill pill-ok">
                    <strong>{livePass}</strong> pass
                  </span>
                  <span className="pill pill-fail">
                    <strong>{liveFail}</strong> fail
                  </span>
                  {stillGoing > 0 && (
                    <span className="pill muted-pill">{stillGoing} in flight</span>
                  )}
                </>
              ) : (
                doneResults.length > 0 && (
                  <span className="pill">
                    <strong>
                      {livePass}/{doneResults.length}
                    </strong>{" "}
                    passed
                  </span>
                )
              )}
              <span className="pill">{data.history.length} runs</span>
              <span className="pill">Reasoning · {effort}</span>
              <span className="pill muted-pill">
                {data.persistent ? "Persistent store" : "In-memory history"}
              </span>
            </>
          )}
        </div>

        {running && (
          <div className="progress-card card">
            <div className="progress-top">
              <div>
                <strong>
                  {progress.done} of {progress.total} models finished
                </strong>
                <span className="muted">
                  {" "}
                  · {stillGoing} still running · {elapsed.toFixed(1)}s elapsed
                </span>
              </div>
              <span className="progress-pct">{pctDone}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pctDone}%` }} />
            </div>
            <div className="chip-row">
              {displayRows.map((row) => (
                <span
                  key={row.model}
                  className={`chip chip-${row.status} ${
                    row.result ? (row.result.ok ? "chip-pass" : "chip-fail") : ""
                  }`}
                  title={
                    row.result
                      ? `${row.model}: ${row.result.ok ? "pass" : "fail"} · ${row.result.duration}s`
                      : `${row.model}: running…`
                  }
                >
                  <span className="chip-dot" />
                  {row.model}
                  {row.result ? (
                    <span className="chip-meta">{row.result.duration.toFixed(1)}s</span>
                  ) : (
                    <span className="chip-meta">…</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {runError && (
          <div className="error-banner card">
            <strong>Run error</strong>
            <span>{runError}</span>
          </div>
        )}

        {!data?.latest && !running && (
          <div className="empty card">
            <div className="empty-icon">○</div>
            <h2>No runs yet</h2>
            <p>A benchmark starts automatically when data is missing or stale.</p>
          </div>
        )}

        {(data?.latest || running) && (
          <section className="card table-card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {SORT_COLUMNS.map((col) => {
                      const active = sortKey === col.key;
                      const ariaSort = active
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none";
                      return (
                        <th
                          key={col.key}
                          className={[
                            "th-sort",
                            active ? "th-sort-active" : "",
                            col.align === "right" ? "th-num" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          aria-sort={ariaSort}
                        >
                          <button
                            type="button"
                            className="th-sort-btn"
                            onClick={() => toggleSort(col.key)}
                            title={
                              active
                                ? `Sorted ${sortDir === "asc" ? "ascending" : "descending"} — click to reverse`
                                : `Sort by ${col.label}`
                            }
                          >
                            <span>{col.label}</span>
                            <span className="sort-ind" aria-hidden>
                              {active ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const r = row.result ?? row.previous;
                    const isLive = row.status === "running";
                    const isStalePrev = isLive && !!row.previous;
                    const rel = reliability[row.model];
                    const relPct =
                      rel && rel.total ? Math.round((100 * rel.ok) / rel.total) : null;

                    return (
                      <tr
                        key={row.model}
                        className={[
                          row.result && !row.result.ok ? "fail" : "",
                          isLive ? "running-row" : "",
                          isStalePrev ? "stale-prev" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <td className="model">{row.model}</td>
                        <td>
                          {isLive ? (
                            <span className="badge badge-run">
                              <span className="mini-spin" />
                              Running
                            </span>
                          ) : row.result ? (
                            row.result.ok ? (
                              <span className="badge badge-ok">Pass</span>
                            ) : (
                              <span className="status-stack">
                                <span className="badge badge-fail">Fail</span>
                                {row.result.failKind && (
                                  <span
                                    className="badge badge-kind"
                                    title={row.result.error ?? undefined}
                                  >
                                    {FAIL_KIND_LABEL[row.result.failKind] ?? row.result.failKind}
                                  </span>
                                )}
                              </span>
                            )
                          ) : (
                            <span className="badge badge-think">Queued</span>
                          )}
                        </td>
                        <td>
                          {isLive && !r ? (
                            <span className="dash">—</span>
                          ) : r?.thinking ? (
                            <span
                              className="badge badge-think"
                              title="Reasoning tokens present in usage (non-streaming)"
                            >
                              Yes
                            </span>
                          ) : (
                            <span className="dash">—</span>
                          )}
                        </td>
                        <td className="num">
                          {!isLive && r ? (r.tokPerSec ?? "—") : isStalePrev ? (r?.tokPerSec ?? "—") : "—"}
                        </td>
                        <td className="num">
                          {!isLive && r
                            ? `${r.duration.toFixed(1)}s`
                            : isLive
                              ? "…"
                              : "—"}
                        </td>
                        <td className="num">
                          {!isLive && r ? (
                            <>
                              {r.tokensOut}
                              {r.reasoningTokens ? (
                                <span className="sub"> ({r.reasoningTokens})</span>
                              ) : null}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num">{!isLive && r ? fmtCost(r.costUSD) : "—"}</td>
                        <td>
                          {relPct !== null ? (
                            <span className="rel">
                              <span className="bar">
                                <span
                                  style={{ width: `${relPct}%` }}
                                  className={relPct >= 90 ? "g" : relPct >= 60 ? "y" : "r"}
                                />
                              </span>
                              <span className="pct">{relPct}%</span>
                            </span>
                          ) : (
                            <span className="dash">—</span>
                          )}
                        </td>
                        <NoteCell
                          text={isLive ? "In flight…" : (row.result?.error ?? "")}
                          detail={
                            isLive
                              ? undefined
                              : row.result?.rawPreview
                                ? `Raw model output:\n${row.result.rawPreview}`
                                : undefined
                          }
                        />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {data && data.history.length > 1 && (
          <section className="charts">
            <div className="section-head">
              <h2>JSON reliability over time</h2>
              <p className="muted">Oldest → newest. Green pass, red fail.</p>
            </div>
            <div className="grid">
              {models.map((m) => (
                <Spark key={m} model={m} history={data.history} />
              ))}
            </div>
          </section>
        )}
      </div>

      <style jsx global>{`
        :root {
          --bg: #fafafa;
          --card: #ffffff;
          --fg: #09090b;
          --muted: #71717a;
          --border: #e4e4e7;
          --border-strong: #d4d4d8;
          --ring: #18181b;
          --ok: #16a34a;
          --ok-bg: #f0fdf4;
          --ok-border: #bbf7d0;
          --fail: #dc2626;
          --fail-bg: #fef2f2;
          --fail-border: #fecaca;
          --run: #2563eb;
          --run-bg: #eff6ff;
          --run-border: #bfdbfe;
          --think-bg: #f4f4f5;
          --think-fg: #3f3f46;
          --warn: #ca8a04;
          --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.03);
          --radius: 12px;
          --radius-sm: 8px;
          --radius-pill: 999px;
        }

        * {
          box-sizing: border-box;
        }

        html,
        body {
          margin: 0;
          min-height: 100%;
        }

        body {
          font-family:
            Inter,
            ui-sans-serif,
            system-ui,
            -apple-system,
            Segoe UI,
            Roboto,
            Helvetica,
            Arial,
            sans-serif;
          font-size: 14px;
          line-height: 1.5;
          background: var(--bg);
          color: var(--fg);
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        .page {
          min-height: 100vh;
          padding: 40px 20px 72px;
        }

        .shell {
          max-width: 1120px;
          margin: 0 auto;
        }

        .hero {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 24px;
          margin-bottom: 20px;
        }

        .eyebrow {
          margin: 0 0 6px;
          font-size: 12px;
          font-weight: 500;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--muted);
        }

        h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 600;
          letter-spacing: -0.03em;
          line-height: 1.2;
        }

        .lede {
          margin: 8px 0 0;
          max-width: 42rem;
          color: var(--muted);
          font-size: 14px;
        }

        .btn-primary {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          flex-shrink: 0;
          min-width: 110px;
          height: 36px;
          padding: 0 16px;
          border: 1px solid var(--ring);
          border-radius: var(--radius-sm);
          background: var(--fg);
          color: #fff;
          font: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          box-shadow: var(--shadow);
          transition:
            background 0.15s ease,
            opacity 0.15s ease;
          font-variant-numeric: tabular-nums;
        }

        .btn-primary:hover:not(:disabled) {
          background: #27272a;
        }

        .btn-primary:disabled {
          opacity: 0.55;
          cursor: default;
        }

        .spinner,
        .mini-spin {
          width: 12px;
          height: 12px;
          border: 2px solid rgba(255, 255, 255, 0.35);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }

        .mini-spin {
          width: 10px;
          height: 10px;
          border-color: rgba(37, 99, 235, 0.25);
          border-top-color: var(--run);
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .meta {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          margin-bottom: 16px;
        }

        .pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 10px;
          border: 1px solid var(--border);
          border-radius: var(--radius-pill);
          background: var(--card);
          color: var(--fg);
          font-size: 12px;
          font-weight: 500;
          box-shadow: var(--shadow);
          font-variant-numeric: tabular-nums;
        }

        .pill strong {
          font-weight: 600;
        }

        .muted-pill {
          color: var(--muted);
          font-weight: 400;
        }

        .pill-live {
          border-color: var(--run-border);
          background: var(--run-bg);
          color: var(--run);
        }

        .pill-ok {
          border-color: var(--ok-border);
          background: var(--ok-bg);
          color: var(--ok);
        }

        .pill-fail {
          border-color: var(--fail-border);
          background: var(--fail-bg);
          color: var(--fail);
        }

        .pill-idle {
          color: var(--muted);
        }

        .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #d4d4d8;
          display: inline-block;
        }

        .dot.live {
          background: var(--run);
          animation: pulse 1.2s ease-in-out infinite;
        }

        @keyframes pulse {
          50% {
            opacity: 0.35;
          }
        }

        .muted {
          color: var(--muted);
        }

        .card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
        }

        .progress-card {
          padding: 14px 16px 12px;
          margin-bottom: 16px;
        }

        .progress-top {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 10px;
          font-size: 13px;
        }

        .progress-pct {
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          color: var(--fg);
        }

        .progress-track {
          height: 8px;
          background: #f4f4f5;
          border: 1px solid var(--border);
          border-radius: var(--radius-pill);
          overflow: hidden;
          margin-bottom: 12px;
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #3b82f6, #2563eb);
          border-radius: var(--radius-pill);
          transition: width 0.25s ease;
        }

        .chip-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 26px;
          padding: 0 9px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--border);
          background: #fafafa;
          font-size: 11px;
          font-weight: 500;
          color: var(--muted);
          font-variant-numeric: tabular-nums;
        }

        .chip-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #d4d4d8;
        }

        .chip-running .chip-dot {
          background: var(--run);
          animation: pulse 1s ease-in-out infinite;
        }

        .chip-running {
          border-color: var(--run-border);
          background: var(--run-bg);
          color: var(--run);
        }

        .chip-done.chip-pass {
          border-color: var(--ok-border);
          background: var(--ok-bg);
          color: var(--ok);
        }

        .chip-done.chip-pass .chip-dot {
          background: var(--ok);
        }

        .chip-done.chip-fail {
          border-color: var(--fail-border);
          background: var(--fail-bg);
          color: var(--fail);
        }

        .chip-done.chip-fail .chip-dot {
          background: var(--fail);
        }

        .chip-meta {
          opacity: 0.75;
          font-weight: 400;
        }

        .error-banner {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 12px 14px;
          margin-bottom: 16px;
          border-color: var(--fail-border);
          background: var(--fail-bg);
          color: var(--fail);
          font-size: 13px;
        }

        .empty {
          padding: 48px 28px;
          text-align: center;
        }

        .empty-icon {
          font-size: 28px;
          color: var(--muted);
          margin-bottom: 12px;
          line-height: 1;
        }

        .empty h2 {
          margin: 0 0 6px;
          font-size: 16px;
          font-weight: 600;
          letter-spacing: -0.01em;
        }

        .empty p {
          margin: 0 auto;
          max-width: 28rem;
          color: var(--muted);
          font-size: 13px;
        }

        .table-card {
          overflow: hidden;
        }

        .table-wrap {
          overflow-x: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        th {
          text-align: left;
          color: var(--muted);
          font-weight: 500;
          font-size: 12px;
          padding: 0;
          border-bottom: 1px solid var(--border);
          white-space: nowrap;
          background: #fcfcfc;
          user-select: none;
        }

        th.th-num .th-sort-btn {
          justify-content: flex-end;
        }

        .th-sort-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          margin: 0;
          padding: 12px 14px;
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          font-weight: 500;
          font-size: 12px;
          letter-spacing: inherit;
          text-align: inherit;
          cursor: pointer;
          border-radius: 0;
        }

        .th-sort-btn:hover {
          color: var(--fg);
          background: #f4f4f5;
        }

        .th-sort-active .th-sort-btn {
          color: var(--fg);
          font-weight: 600;
        }

        .sort-ind {
          font-size: 10px;
          line-height: 1;
          opacity: 0.35;
          font-variant-numeric: tabular-nums;
        }

        .th-sort-active .sort-ind {
          opacity: 0.85;
          color: var(--run);
        }

        .th-sort-btn:hover .sort-ind {
          opacity: 0.7;
        }

        td {
          padding: 12px 14px;
          border-bottom: 1px solid var(--border);
          vertical-align: middle;
        }

        tbody tr:last-child td {
          border-bottom: none;
        }

        tbody tr:hover td {
          background: #fafafa;
        }

        tr.fail td {
          background: #fffbfb;
        }

        tr.fail:hover td {
          background: #fef6f6;
        }

        tr.running-row td {
          background: #f8fafc;
        }

        tr.running-row:hover td {
          background: #f1f5f9;
        }

        tr.stale-prev td.num,
        tr.stale-prev td.note {
          opacity: 0.45;
        }

        .model {
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.01em;
          white-space: nowrap;
        }

        tr.fail .model {
          color: var(--fail);
        }

        .num {
          font-variant-numeric: tabular-nums;
          color: #3f3f46;
          white-space: nowrap;
        }

        .sub {
          color: var(--muted);
        }

        .dash {
          color: #a1a1aa;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 22px;
          padding: 0 8px;
          border-radius: var(--radius-pill);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.01em;
          border: 1px solid transparent;
          white-space: nowrap;
        }

        .badge-ok {
          color: var(--ok);
          background: var(--ok-bg);
          border-color: var(--ok-border);
        }

        .badge-fail {
          color: var(--fail);
          background: var(--fail-bg);
          border-color: var(--fail-border);
        }

        .badge-run {
          color: var(--run);
          background: var(--run-bg);
          border-color: var(--run-border);
        }

        .badge-think {
          color: var(--think-fg);
          background: var(--think-bg);
          border-color: var(--border);
        }

        .badge-kind {
          color: #9a3412;
          background: #fff7ed;
          border-color: #fed7aa;
          font-weight: 500;
        }

        .status-stack {
          display: inline-flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
        }

        .inline-code {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
          background: #f4f4f5;
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 1px 5px;
        }

        .note {
          color: var(--muted);
          font-size: 12px;
          max-width: 220px;
          cursor: default;
          outline: none;
        }

        .note-text {
          display: block;
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .note:hover .note-text,
        .note:focus .note-text {
          color: var(--fg);
        }

        /* Fixed so it isn't clipped by the table's overflow-x scroll container. */
        .note-tip {
          position: fixed;
          z-index: 50;
          transform: translateY(calc(-100% - 8px));
          max-width: min(420px, calc(100vw - 24px));
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--card);
          color: var(--fg);
          font-size: 12px;
          font-weight: 400;
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
          box-shadow:
            0 4px 12px rgba(0, 0, 0, 0.08),
            0 1px 2px rgba(0, 0, 0, 0.04);
          pointer-events: none;
        }

        .rel {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }

        .bar {
          width: 56px;
          height: 6px;
          background: #f4f4f5;
          border: 1px solid var(--border);
          border-radius: 3px;
          overflow: hidden;
          display: inline-block;
        }

        .bar span {
          display: block;
          height: 100%;
          border-radius: 2px;
        }

        .bar .g {
          background: var(--ok);
        }
        .bar .y {
          background: var(--warn);
        }
        .bar .r {
          background: var(--fail);
        }

        .pct {
          font-variant-numeric: tabular-nums;
          font-size: 12px;
          color: #3f3f46;
          min-width: 2.5em;
        }

        .charts {
          margin-top: 28px;
        }

        .section-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }

        .section-head h2 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: -0.01em;
        }

        .section-head .muted {
          font-size: 12px;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
          gap: 12px;
        }

        .spark {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 14px;
          box-shadow: var(--shadow);
        }

        .spark .name {
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 10px;
          letter-spacing: -0.01em;
          display: flex;
          justify-content: space-between;
          gap: 8px;
        }

        .spark .name .score {
          color: var(--muted);
          font-weight: 500;
        }

        @media (max-width: 640px) {
          .page {
            padding: 24px 14px 48px;
          }
          .hero {
            flex-direction: column;
          }
          .btn-primary {
            width: 100%;
          }
          h1 {
            font-size: 24px;
          }
        }
      `}</style>
    </main>
  );
}

function NoteCell({ text, detail }: { text: string; detail?: string }) {
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  if (!text) return <td className="note" />;
  const full = detail ? `${text}\n\n${detail}` : text;

  return (
    <td
      className="note"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ left: r.left, top: r.top });
      }}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ left: r.left, top: r.top });
      }}
      onBlur={() => setTip(null)}
      tabIndex={0}
    >
      <span className="note-text">{text}</span>
      {tip && (
        <span
          className="note-tip"
          role="tooltip"
          style={{ left: tip.left, top: tip.top }}
        >
          {full}
        </span>
      )}
    </td>
  );
}

function Spark({ model, history }: { model: string; history: Run[] }) {
  const series = [...history].reverse().map((run) => {
    const r = run.results.find((x) => x.model === model);
    return r ? (r.ok ? 1 : 0) : -1;
  });
  const w = 182;
  const h = 36;
  const n = series.length;
  const bw = n ? w / n : w;
  const okCount = series.filter((v) => v === 1).length;
  const total = series.filter((v) => v >= 0).length;
  const pct = total ? Math.round((100 * okCount) / total) : 0;

  return (
    <div className="spark">
      <div className="name">
        <span>{model}</span>
        <span className="score">{pct}%</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" height={h}>
        {series.map((v, i) => (
          <rect
            key={i}
            x={i * bw}
            y={v === 1 ? h * 0.12 : h * 0.48}
            width={Math.max(1.5, bw - 1.5)}
            height={v === 1 ? h * 0.88 : h * 0.52}
            rx={1.5}
            fill={v === 1 ? "#16a34a" : v === 0 ? "#dc2626" : "#e4e4e7"}
          />
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

/** Show small per-call costs (often well under $0.01). */
function fmtCost(c: number | null | undefined) {
  if (c == null || !Number.isFinite(c) || c <= 0) return "—";
  if (c < 0.0001) return `$${c.toFixed(6)}`;
  if (c < 0.01) return `$${c.toFixed(5)}`;
  return `$${c.toFixed(4)}`;
}
