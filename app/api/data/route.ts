import { NextResponse } from "next/server";
import { getHistory, persistent } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fast read path for the dashboard: latest run + recent history, no LLM calls.
export async function GET() {
  const history = await getHistory(60);
  return NextResponse.json({
    latest: history[0] ?? null,
    history,
    persistent,
    now: Date.now(),
  });
}
