import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// List + create rules. Editing your own categorization rules is the thing
// Copilot won't let you do — here they're first-class.
export async function GET() {
  const rules = db().prepare(
    `SELECT id, match_type, pattern, field, category, entity, rename, priority, source
     FROM rules ORDER BY priority ASC, id ASC`
  ).all();
  return NextResponse.json({ rules });
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.pattern || !(b.category || b.entity || b.rename)) {
    return NextResponse.json({ error: "pattern + at least one of category/entity/rename required" }, { status: 400 });
  }
  const d = db();
  const info = d.prepare(
    `INSERT INTO rules (match_type, pattern, field, category, entity, rename, priority, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`
  ).run(
    b.match_type ?? "contains",
    b.pattern,
    b.field ?? "merchant",
    b.category ?? null,
    b.entity ?? null,
    b.rename ?? null,
    b.priority ?? 100
  );

  // Optionally apply the new rule to existing matching transactions right away.
  let applied = 0;
  if (b.applyNow) {
    const like = `%${String(b.pattern).toLowerCase()}%`;
    const col = b.field === "name" ? "name" : "merchant";
    const sets: string[] = [];
    const args: unknown[] = [];
    if (b.category) { sets.push("category=?", "category_source='rule'", "confidence=1.0"); args.push(b.category); }
    if (b.entity) { sets.push("entity=?"); args.push(b.entity); }
    if (b.rename) { sets.push("merchant=?"); args.push(b.rename); }
    if (sets.length) {
      args.push(like);
      const res = d.prepare(
        `UPDATE transactions SET ${sets.join(", ")} WHERE lower(${col}) LIKE ?`
      ).run(...(args as never[]));
      applied = Number(res.changes ?? 0);
    }
  }
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid), applied });
}
