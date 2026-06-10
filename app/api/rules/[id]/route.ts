import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  db().prepare(`DELETE FROM rules WHERE id=?`).run(Number(id));
  return NextResponse.json({ ok: true });
}
