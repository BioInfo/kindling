import { NextRequest, NextResponse } from "next/server";
import { plaid } from "@/lib/plaid";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { decrypt } from "@/lib/crypto";
import { Products, CountryCode } from "plaid";

export const dynamic = "force-dynamic";

// Creates an update-mode link_token for an EXISTING item so the user can grant
// consent for additional products (investments) without re-linking. Update mode
// reuses the same access_token and account_ids — no duplicate item, no duplicate
// accounts. The client opens Plaid Link with this token; on success the consent
// is granted server-side and holdings calls start working (no token exchange).
export async function POST(req: NextRequest) {
  try {
    const { item_id } = await req.json();
    if (!item_id) {
      return NextResponse.json({ error: "missing item_id" }, { status: 400 });
    }
    const row = db().prepare(`SELECT access_token FROM items WHERE id=?`).get(item_id) as
      | { access_token: string }
      | undefined;
    if (!row) {
      return NextResponse.json({ error: "unknown item_id" }, { status: 404 });
    }

    const res = await plaid.linkTokenCreate({
      user: { client_user_id: "local-user" },
      client_name: "Kindling",
      access_token: decrypt(row.access_token), // update mode
      additional_consented_products: config.plaid.additionalConsentedProducts as Products[],
      country_codes: config.plaid.countryCodes as CountryCode[],
      language: "en",
    });
    return NextResponse.json({ link_token: res.data.link_token });
  } catch (e: unknown) {
    // Some institutions (e.g. Ally Bank) simply don't offer Plaid's investments
    // product. Plaid rejects the token with a "not supported" message. Classify
    // that as `unsupported` so the UI shows an honest note, not a dead button.
    const data = (e as { response?: { data?: { error_message?: string } } })?.response?.data;
    const plaidMsg = data?.error_message;
    const msg = plaidMsg ?? (e instanceof Error ? e.message : String(e));
    if (plaidMsg && /not supported/i.test(plaidMsg)) {
      return NextResponse.json({ unsupported: true, message: plaidMsg });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
