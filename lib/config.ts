/**
 * Runtime config. Secrets are injected as env vars by ./run.sh (sourced from `pass`).
 * Nothing secret is ever read from a file on disk.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (run via ./run.sh)`);
  return v;
}

export const config = {
  plaid: {
    clientId: req("PLAID_CLIENT_ID"),
    secret: req("PLAID_SECRET"),
    env: (process.env.PLAID_ENV ?? "sandbox") as "sandbox" | "production",
    // Products we request at link. Transactions + balances drive the MVP.
    products: ["transactions"],
    // Consented-to but not required at link. Investments holdings are pulled
    // when an account supports them (brokerages); bank-only links still succeed
    // because investments isn't a required product. Existing items that linked
    // before this consent was added re-consent via Link update mode.
    additionalConsentedProducts: ["investments"],
    countryCodes: ["US"],
  },
  // 32-byte hex key for AES-256-GCM encryption of access tokens at rest.
  encKeyHex: req("APP_ENC_KEY"),
  db: {
    path: process.env.FINANCE_DB_PATH ?? "./data/finance.db",
  },
  // LLM is fully swappable: change FINANCE_LLM_MODEL to point at any gateway model.
  // Choose a model served on your own network to keep financial data private.
  llm: {
    baseUrl: process.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1",
    apiKey: process.env.LITELLM_API_KEY ?? "",
    model: process.env.FINANCE_LLM_MODEL ?? "deepseek-v4-flash",
  },
};
