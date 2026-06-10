import { NextRequest, NextResponse } from "next/server";
import { plaid, institutionName } from "@/lib/plaid";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { syncConnectionEvents } from "@/lib/networth";

export const dynamic = "force-dynamic";

// Exchanges the public_token from Link for a permanent access_token,
// stores it (encrypted) as an Item, and records its accounts.
export async function POST(req: NextRequest) {
  try {
    const { public_token } = await req.json();
    if (!public_token) {
      return NextResponse.json({ error: "missing public_token" }, { status: 400 });
    }

    const ex = await plaid.itemPublicTokenExchange({ public_token });
    const accessToken = ex.data.access_token;
    const itemId = ex.data.item_id;

    // Pull institution id + accounts, then resolve the human-readable name so
    // the UI shows "Ally Bank" instead of "ins_25". Name is best-effort —
    // ON CONFLICT keeps any existing name if this lookup comes back null.
    const acctRes = await plaid.accountsGet({ access_token: accessToken });
    const institution = acctRes.data.item.institution_id ?? null;
    const instName = institution ? await institutionName(institution) : null;

    const d = db();
    d.prepare(
      `INSERT INTO items (id, institution, institution_name, access_token, status)
       VALUES (?, ?, ?, ?, 'good')
       ON CONFLICT(id) DO UPDATE SET
         access_token=excluded.access_token, status='good', error=NULL,
         institution_name=COALESCE(excluded.institution_name, items.institution_name)`
    ).run(itemId, institution, instName, encrypt(accessToken));

    const upsertAcct = d.prepare(
      `INSERT INTO accounts (id, item_id, name, official_name, mask, type, subtype,
         current_balance, available_balance, currency, updated_at)
       VALUES (@id, @item_id, @name, @official_name, @mask, @type, @subtype,
         @current_balance, @available_balance, @currency, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         current_balance=excluded.current_balance,
         available_balance=excluded.available_balance,
         updated_at=datetime('now')`
    );
    for (const a of acctRes.data.accounts) {
      upsertAcct.run({
        id: a.account_id,
        item_id: itemId,
        name: a.name,
        official_name: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type ?? null,
        subtype: a.subtype ?? null,
        current_balance: a.balances.current ?? null,
        available_balance: a.balances.available ?? null,
        currency: a.balances.iso_currency_code ?? null,
      });
    }

    // Record the connection event now (link-time balances) so this item's
    // freshly-visible balance never reads as net-worth growth in the trend.
    syncConnectionEvents();

    return NextResponse.json({ ok: true, item_id: itemId, accounts: acctRes.data.accounts.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
