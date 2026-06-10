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
