import { NextRequest, NextResponse } from "next/server";
import { listGoals, createGoal, updateGoal, deleteGoal } from "@/lib/goals";

export const dynamic = "force-dynamic";

// GET: all goals with derived progress + nudge + recent savings rate.
export async function GET() {
  return NextResponse.json(listGoals());
}

// POST: create a goal { name, target, saved?, deadline? }.
export async function POST(req: NextRequest) {
  const b = await req.json();
  const target = Number(b.target);
  if (!b.name || typeof b.name !== "string" || !b.name.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (!Number.isFinite(target) || target <= 0) {
    return NextResponse.json({ error: "target must be a positive number" }, { status: 400 });
  }
  const saved = Number(b.saved);
  const id = createGoal(b.name, target, Number.isFinite(saved) ? saved : 0, b.deadline);
  return NextResponse.json({ ok: true, id });
}

// PATCH: edit a goal { id, name?, target?, saved?, deadline? }.
export async function PATCH(req: NextRequest) {
  const b = await req.json();
  const id = Number(b.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const fields: { name?: string; target?: number; saved?: number; deadline?: string | null } = {};
  if (typeof b.name === "string") fields.name = b.name;
  if (b.target !== undefined && Number.isFinite(Number(b.target))) fields.target = Number(b.target);
  if (b.saved !== undefined && Number.isFinite(Number(b.saved))) fields.saved = Number(b.saved);
  if (b.deadline !== undefined) fields.deadline = b.deadline || null;
  updateGoal(id, fields);
  return NextResponse.json({ ok: true });
}

// DELETE: remove a goal by ?id=.
export async function DELETE(req: NextRequest) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteGoal(id);
  return NextResponse.json({ ok: true });
}
