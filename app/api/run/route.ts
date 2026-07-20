import { runAll, type ProgressEvent } from "@/lib/bench";
import { MODELS, REASONING_EFFORT } from "@/lib/models";
import { saveRun, getLatest } from "@/lib/store";

export const runtime = "nodejs";
// Must exceed the per-model timeout (90s). Needs a Vercel plan that allows it
// (Hobby caps at 60s → lower TIMEOUT_MS, or upgrade).
export const maxDuration = 120;
export const dynamic = "force-dynamic";

// Streams NDJSON progress events so the UI can update model-by-model.
// Cron still works: it just ignores intermediate lines and the final save still happens.
export async function GET() {
  const key = process.env.SURPLUS_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ error: "SURPLUS_API_KEY not set" }) + "\n", {
      status: 500,
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
    });
  }

  const latest = await getLatest();
  if (latest && Date.now() - latest.at < 60_000) {
    const skipped: ProgressEvent = { type: "skipped", run: latest };
    return new Response(JSON.stringify(skipped) + "\n", {
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
    });
  }

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
          at: Date.now(),
          reasoningEffort: REASONING_EFFORT,
        });
        const run = await runAll(key, (result, done, total) => {
          send({ type: "result", result, done, total });
        });
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
      // Disable proxy buffering so progress lines flush promptly.
      "X-Accel-Buffering": "no",
    },
  });
}
