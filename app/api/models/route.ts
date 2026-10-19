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
    id: "glm-latest",
    label: "GLM 5.3 (thinking)",
    location: "remote" as const,
    provider: "Z.ai",
    blurb: "Default: reasons before answering — data leaves your network (z.ai plan, no per-token cost)",
  },
  {
    id: "glm-author",
    label: "GLM 5.3 (fast)",
    location: "remote" as const,
    provider: "Z.ai",
    blurb: "Same model with thinking off, for quick lookups — data leaves your network",
  },
  {
    id: "deepseek-flash-latest",
    label: "DeepSeek V4 Flash",
    location: "remote" as const,
    provider: "DeepSeek",
    blurb: "Fallback — pay-per-token, data leaves your network",
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
