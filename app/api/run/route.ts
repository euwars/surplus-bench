import { NextResponse } from "next/server";
import { runAll } from "@/lib/bench";
import { saveRun, getLatest } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60; // seconds — the whole benchmark must fit here
export const dynamic = "force-dynamic";

// Runs one benchmark pass over all models and stores it. Called by the Vercel
// cron every 10 minutes, and on demand from the UI when data is missing/stale.
export async function GET() {
  const key = process.env.SURPLUS_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "SURPLUS_API_KEY not set" }, { status: 500 });
  }
  // Skip if a very recent run already exists (avoids duplicate work when the
  // cron and a UI-triggered run overlap).
  const latest = await getLatest();
  if (latest && Date.now() - latest.at < 60_000) {
    return NextResponse.json({ skipped: true, run: latest });
  }
  const run = await runAll(key);
  await saveRun(run);
  return NextResponse.json({ run });
}
