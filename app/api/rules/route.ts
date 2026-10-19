import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { RULE_ORDER, ruleMatches } from "@/lib/categorize";

export const dynamic = "force-dynamic";

// List + create rules. Editing your own categorization rules is the thing
// Copilot won't let you do — here they're first-class.
export async function GET() {
  const rules = db().prepare(
    `SELECT id, match_type, pattern, field, category, entity, rename, priority, source
     FROM rules ORDER BY ${RULE_ORDER}`
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
    // Match in JS with the sync matcher, so exact/regex rules apply as written
    // and % or _ in a pattern are literal. A merchant rule falls back to the
    // name when merchant is empty, same as applyRules().
    const rule = { match_type: b.match_type ?? "contains", pattern: String(b.pattern), field: b.field ?? "merchant" };
    const ids = (d.prepare(`SELECT id, merchant, name FROM transactions`).all() as
      { id: string; merchant: string | null; name: string | null }[])
      .filter((t) => ruleMatches(rule, t.merchant, t.name ?? ""))
      .map((t) => t.id);
    const sets: string[] = [];
    const args: unknown[] = [];
    // A hand-set category (category_source='manual') is never overwritten.
    const manual = "COALESCE(category_source,'')='manual'";
    if (b.category) {
      sets.push(
        `category=CASE WHEN ${manual} THEN category ELSE ? END`,
        `confidence=CASE WHEN ${manual} THEN confidence ELSE 1.0 END`,
        `category_source=CASE WHEN ${manual} THEN category_source ELSE 'rule' END`,
      );
      args.push(b.category);
    }
    if (b.entity) { sets.push("entity=?"); args.push(b.entity); }
    if (b.rename) { sets.push("merchant=?"); args.push(b.rename); }
    if (sets.length && ids.length) {
      const stmt = d.prepare(
        `UPDATE transactions SET ${sets.join(", ")} WHERE id=?` +
          (b.entity || b.rename ? "" : ` AND NOT ${manual}`)
      );
      for (const id of ids) applied += Number(stmt.run(...(args as never[]), id).changes ?? 0);
    }
  }
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid), applied });
}
