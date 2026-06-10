import { NextResponse } from "next/server";
import { plaid } from "@/lib/plaid";
import { config } from "@/lib/config";
import { Products, CountryCode } from "plaid";

export const dynamic = "force-dynamic";

// Creates a link_token the Plaid Link widget needs to start a connection.
export async function POST() {
  try {
    const res = await plaid.linkTokenCreate({
      user: { client_user_id: "local-user" },
      client_name: "Kindling",
      products: config.plaid.products as Products[],
      // Consent to investments without requiring it, so brokerage links yield
      // holdings while bank-only links still succeed.
      additional_consented_products: config.plaid.additionalConsentedProducts as Products[],
      country_codes: config.plaid.countryCodes as CountryCode[],
      language: "en",
    });
    return NextResponse.json({ link_token: res.data.link_token });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
