import { runAll, type ProgressEvent, type RunSource } from "@/lib/bench";
import { MODELS, REASONING_EFFORT } from "@/lib/models";
import { saveRun, getLatest } from "@/lib/store";

export const runtime = "nodejs";
// Must exceed the per-model timeout (90s). Needs a Vercel plan that allows it
// (Hobby caps at 60s → lower TIMEOUT_MS, or upgrade).
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function ndjson(event: ProgressEvent, status = 200) {
  return new Response(JSON.stringify(event) + "\n", {
    status,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

async function handleRun(source: RunSource) {
  const key = process.env.SURPLUS_API_KEY;
  if (!key) {
    return ndjson({ type: "error", error: "SURPLUS_API_KEY not set" }, 500);
  }

  // Debounce double-fires (cron + stray click within 60s).
  const latest = await getLatest();
  if (latest && Date.now() - latest.at < 60_000) {
    return ndjson({ type: "skipped", run: latest });
  }

  const startedAt = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProgressEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        send({
          type: "start",
          models: MODELS,
          at: startedAt,
          reasoningEffort: REASONING_EFFORT,
        });
        const run = await runAll(
          key,
          (result, done, total) => {
            send({ type: "result", result, done, total });
          },
          { source, startedAt },
        );
        await saveRun(run);
        send({ type: "done", run });
      } catch (e: any) {
        send({ type: "error", error: String(e?.message ?? e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Vercel Cron — GET /api/run on the schedule in vercel.json. */
export async function GET() {
  return handleRun("cron");
}

/** Explicit "Run now" from the dashboard. UI never auto-calls this. */
export async function POST() {
  return handleRun("manual");
}
