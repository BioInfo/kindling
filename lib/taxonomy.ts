// Your category taxonomy — finer than Plaid's coarse PFC primary buckets.
// The LLM is constrained to these; rules and manual edits can use anything.
export const CATEGORIES = [
  "Income",
  "Transfer:Brokerage",
  "Transfer:Internal",
  "Transfer:P2P",
  "CreditCardPayment",
  "Rent",
  "Mortgage",
  "Utilities",
  "Groceries",
  "Dining",
  "Shopping",
  "Travel",
  "Transportation",
  "Subscriptions",
  "Entertainment",
  "Healthcare",
  "Insurance",
  "Education",
  "Fees",
  "Taxes",
  "TaxRefund",
  "Charity",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

// Plaid PFC primary → our taxonomy, for the ONLY-safe 1:1 mappings. When no rule
// matches, sync falls back to the raw Plaid primary (sync.ts), which leaks coarse
// SCREAMING_SNAKE labels into the spending list (e.g. FOOD_AND_DRINK alongside the
// curated Dining). Only the unambiguous primaries live here (db.ts re-maps raw
// rows from this table on startup); ambiguous ones resolve through the detailed
// map in mapPfc() or land on "Other", the review queue's catch-all.
export const PFC_MAP: Record<string, Category> = {
  FOOD_AND_DRINK: "Dining",
  GENERAL_MERCHANDISE: "Shopping",
  ENTERTAINMENT: "Entertainment",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Travel",
  MEDICAL: "Healthcare",
  RENT_AND_UTILITIES: "Utilities",
  BANK_FEES: "Fees",
  INCOME: "Income",
};

// Plaid PFC detailed → our taxonomy. Detailed is decisive where the primary is
// not: Plaid files tavernas and Lululemon under primary OTHER with a real
// detailed (FOOD_AND_DRINK_RESTAURANT), and splits LOAN_PAYMENTS / TRANSFER_*
// into mortgage vs card vs P2P. Exact key first, then the longest prefix.
const PFC_DETAILED: Record<string, Category> = {
  FOOD_AND_DRINK_GROCERIES: "Groceries",
  FOOD_AND_DRINK: "Dining",
  GENERAL_MERCHANDISE: "Shopping",
  ENTERTAINMENT: "Entertainment",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Travel",
  MEDICAL: "Healthcare",
  RENT_AND_UTILITIES_RENT: "Rent",
  RENT_AND_UTILITIES: "Utilities",
  BANK_FEES: "Fees",
  INCOME_TAX_REFUND: "TaxRefund",
  INCOME: "Income",
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: "CreditCardPayment",
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: "Mortgage",
  TRANSFER_IN_ACCOUNT_TRANSFER: "Transfer:Internal",
  TRANSFER_IN_SAVINGS: "Transfer:Internal",
  TRANSFER_IN_TRANSFER_IN_FROM_APPS: "Transfer:P2P",
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: "Transfer:Brokerage",
  TRANSFER_OUT_ACCOUNT_TRANSFER: "Transfer:Internal",
  TRANSFER_OUT_SAVINGS: "Transfer:Internal",
  TRANSFER_OUT_WITHDRAWAL: "Transfer:Internal",
  TRANSFER_OUT_TRANSFER_OUT_FROM_APPS: "Transfer:P2P",
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: "Transfer:Brokerage",
  GENERAL_SERVICES_INSURANCE: "Insurance",
  GENERAL_SERVICES_EDUCATION: "Education",
  GENERAL_SERVICES_AUTOMOTIVE: "Transportation",
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: "Taxes",
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: "Charity",
  HOME_IMPROVEMENT_FURNITURE: "Shopping",
  HOME_IMPROVEMENT_HARDWARE: "Shopping",
};

// Primaries with no safe 1:1 bucket: without a decisive detailed they land on
// "Other" (still in review) instead of leaking the raw token.
const PFC_AMBIGUOUS = new Set([
  "OTHER", "LOAN_PAYMENTS", "GENERAL_SERVICES", "TRANSFER_IN", "TRANSFER_OUT",
  "GOVERNMENT_AND_NON_PROFIT", "HOME_IMPROVEMENT", "PERSONAL_CARE",
]);

export function mapPfc(primary: string | null | undefined, detailed?: string | null): Category | null {
  if (detailed) {
    if (PFC_DETAILED[detailed]) return PFC_DETAILED[detailed];
    let best = "";
    for (const k of Object.keys(PFC_DETAILED)) {
      if (detailed.startsWith(k + "_") && k.length > best.length) best = k;
    }
    if (best) return PFC_DETAILED[best];
  }
  if (!primary) return null;
  return PFC_MAP[primary] ?? (PFC_AMBIGUOUS.has(primary) ? "Other" : null);
}

// Display label for a category, server-side twin of app/ui.tsx prettyCategory
// (that file is "use client" so libs can't import it). Taxonomy values pass
// through; a raw Plaid SCREAMING_SNAKE primary still in the review queue
// (LOAN_PAYMENTS) gets Title-Cased so summaries/charts never show the raw token.
export function prettyCategory(c: string | null): string {
  if (!c) return "Uncategorized";
  if (!/_/.test(c) && c !== c.toUpperCase()) return c;
  return c.toLowerCase().split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
