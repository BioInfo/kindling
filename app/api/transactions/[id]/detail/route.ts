import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Pull the useful bits out of the stored raw Plaid transaction JSON for a single
// row: which account/institution it hit, whether it was online or in store,
// where, the merchant's website/logo, the detailed category, and when it was
// authorized vs posted. Parsed on demand (the list payload stays light) when a
// row is expanded. Local only — nothing leaves the box.

type Loc = { city?: string | null; region?: string | null; store_number?: string | null; address?: string | null };

const titleize = (s: string) =>
  s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const channel = (c?: string | null) =>
  c === "online" ? "Online" : c === "in store" ? "In store" : c ? titleize(c) : null;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = db().prepare(
    `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.currency, t.pending,
            t.category, t.category_source, t.confidence, t.entity, t.note, t.raw,
            a.name AS account, a.mask AS account_mask, a.subtype AS account_subtype,
            COALESCE(i.institution_name, i.institution) AS institution
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN items i ON i.id = a.item_id WHERE t.id = ?`
  ).get(id) as
    | {
        id: string; date: string; name: string; merchant: string | null; amount: number;
        currency: string | null; pending: number; category: string | null;
        category_source: string | null; confidence: number | null;
        entity: string | null; note: string | null; raw: string | null;
        account: string; account_mask: string | null; account_subtype: string | null;
        institution: string | null;
      }
    | undefined;
  if (!t) return NextResponse.json({ error: "unknown transaction" }, { status: 404 });

  let raw: Record<string, unknown> = {};
  try { raw = t.raw ? JSON.parse(t.raw) : {}; } catch { /* tolerate bad/absent raw */ }

  const loc = (raw.location ?? {}) as Loc;
  const locParts = [loc.city, loc.region].filter(Boolean) as string[];
  const cp = Array.isArray(raw.counterparties) && raw.counterparties.length
    ? (raw.counterparties[0] as { website?: string | null; logo_url?: string | null })
    : null;
  const pfc = (raw.personal_finance_category ?? {}) as { detailed?: string | null };
  const authDate = (raw.authorized_date as string | null) ?? null;

  return NextResponse.json({
    id: t.id,
    // Header / editable fields for the txn detail modal.
    amount: t.amount, currency: t.currency ?? "USD", date: t.date,
    entity: t.entity ?? "personal", note: t.note ?? null,
    account: t.account, accountMask: t.account_mask, institution: t.institution,
    accountSubtype: t.account_subtype,
    rawName: t.name,
    merchant: t.merchant,
    channel: channel(raw.payment_channel as string | null),
    location: locParts.length ? locParts.join(", ") : null,
    storeNumber: loc.store_number ?? null,
    website: (raw.website as string | null) ?? cp?.website ?? null,
    logoUrl: (raw.logo_url as string | null) ?? cp?.logo_url ?? null,
    detailedCategory: pfc.detailed ? titleize(pfc.detailed) : null,
    category: t.category,
    categorySource: t.category_source,
    confidence: t.confidence,
    transactionType: (raw.transaction_type as string | null) ?? null,
    authorizedDate: authDate && authDate !== t.date ? authDate : null,
    postedDate: t.date,
    pending: !!t.pending,
  });
}
