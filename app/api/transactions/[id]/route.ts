import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rememberMerchantCategory } from "@/lib/categorize";

export const dynamic = "force-dynamic";

// Edit a single transaction: category, entity, merchant (display), reviewed flag.
// A manual edit sets category_source='manual' so the LLM never overwrites it.
// Setting a category also "remembers" the merchant: it writes a manual rule and
// fills the blanks on sibling rows (set propagate:false to skip). The response
// carries an undo token so the UI can revert that propagation.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const d = db();

  const sets: string[] = [];
  const args: unknown[] = [];
  const settingCategory = typeof body.category === "string";
  if (settingCategory) { sets.push("category=?", "category_source='manual'", "confidence=1.0"); args.push(body.category); }
  if (typeof body.entity === "string") { sets.push("entity=?"); args.push(body.entity); }
  if (typeof body.merchant === "string") { sets.push("merchant=?"); args.push(body.merchant); }
  if (typeof body.note === "string") { sets.push("note=?"); args.push(body.note.trim() || null); }
  if (typeof body.reviewed === "boolean") { sets.push("reviewed=?"); args.push(body.reviewed ? 1 : 0); }
  if (sets.length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  args.push(id);
  d.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id=?`).run(...(args as never[]));

  // Remember the merchant for next time + fill in sibling blanks now.
  let propagation = null;
  if (settingCategory && body.propagate !== false) {
    propagation = rememberMerchantCategory(id, body.category as string);
  }
  return NextResponse.json({ ok: true, propagation });
}
