import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Curated, verified model list for the chat picker. A gateway often exposes many
// models but some are broken routes — a hand-picked, tested set beats exposing
// everything. Each is tagged local (data stays on your network) vs remote (leaves
// your network) so the privacy choice is explicit. Override per-deployment without
// a code change by setting FINANCE_MODELS to a JSON array of the same shape.
const CURATED = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash (fast)",
    location: "remote" as const,
    provider: "DeepSeek",
    blurb: "Fast non-reasoning default — data leaves your network",
  },
  {
    id: "deepseek-v4",
    label: "DeepSeek V4 (reasoning)",
    location: "remote" as const,
    provider: "DeepSeek",
    blurb: "Heavy reasoner for hard questions — data leaves your network",
  },
  {
    id: "google/gemini-2.5-flash-lite",
    label: "Gemini Flash Lite (cheap)",
    location: "remote" as const,
    provider: "Google",
    blurb: "Fast and cheap for quick lookups — data leaves your network",
  },
];

export async function GET() {
  // FINANCE_MODELS (JSON array, same shape as CURATED) overrides the roster
  // per-deployment without a code change.
  let models = CURATED;
  try {
    if (process.env.FINANCE_MODELS) models = JSON.parse(process.env.FINANCE_MODELS);
  } catch { /* malformed override → fall back to the curated list */ }
  return NextResponse.json({ models, default: models[0]?.id ?? CURATED[0].id });
}
