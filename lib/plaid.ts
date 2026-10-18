import { Configuration, PlaidApi, PlaidEnvironments, CountryCode } from "plaid";
import { config } from "./config";
import { db } from "./db";

const configuration = new Configuration({
  basePath: PlaidEnvironments[config.plaid.env],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": config.plaid.clientId,
      "PLAID-SECRET": config.plaid.secret,
    },
  },
});

export const plaid = new PlaidApi(configuration);

// Resolve a Plaid institution_id (e.g. "ins_25") to its display name ("Ally
// Bank"). Returns null on any failure so callers fall back to showing the id.
export async function institutionName(institutionId: string): Promise<string | null> {
  try {
    const r = await plaid.institutionsGetById({
      institution_id: institutionId,
      country_codes: config.plaid.countryCodes as CountryCode[],
    });
    return r.data.institution.name ?? null;
  } catch {
    return null;
  }
}

// Fill institution_name for every item that's missing one (and refresh the
// label on its connection_events so the net-worth note reads prettily too).
// Idempotent and cheap — safe to call on demand. Returns how many were resolved.
export async function backfillInstitutionNames(): Promise<number> {
  const d = db();
  const rows = d.prepare(
    `SELECT id, institution FROM items
     WHERE institution IS NOT NULL AND COALESCE(institution_name, '') = ''`
  ).all() as unknown as { id: string; institution: string }[];
  const updItem = d.prepare(`UPDATE items SET institution_name = ? WHERE id = ?`);
  const updEvent = d.prepare(`UPDATE connection_events SET label = ? WHERE item_id = ?`);
  let n = 0;
  for (const r of rows) {
    const name = await institutionName(r.institution);
    if (name) { updItem.run(name, r.id); updEvent.run(name, r.id); n++; }
  }
  return n;
}

// Plaid error codes that mean the bank login itself has to be redone in Link
// update mode. Anything else is a generic 'error' (outage, rate limit, bug).
const REAUTH_CODES = new Set([
  "ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "INVALID_CREDENTIALS",
  "INVALID_MFA", "ITEM_LOCKED", "USER_SETUP_REQUIRED", "INSUFFICIENT_CREDENTIALS", "ACCESS_NOT_GRANTED",
]);

// axios hides Plaid's error_code behind a bare "Request failed with status code
// 400", which is all items.error used to hold. Pull the real code + message.
export function classifyPlaidError(e: unknown): { status: "re-auth" | "error"; code: string | null; message: string } {
  const data = (e as { response?: { data?: { error_code?: string; error_message?: string } } })?.response?.data;
  const code = data?.error_code ?? null;
  const text = data?.error_message ?? (e instanceof Error ? e.message : String(e));
  return { status: code && REAUTH_CODES.has(code) ? "re-auth" : "error", code, message: code ? `${code}: ${text}` : text };
}
