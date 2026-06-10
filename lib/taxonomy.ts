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
// curated Dining). Map the unambiguous ones; deliberately leave ambiguous coarse
// buckets (LOAN_PAYMENTS = mortgage vs auto vs CC, GENERAL_SERVICES, TRANSFER_OUT,
// GOVERNMENT_AND_NON_PROFIT, PERSONAL_CARE) raw so they stay in the review queue
// for a real assignment rather than being force-bucketed.
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

export function mapPfc(primary: string | null | undefined): Category | null {
  if (!primary) return null;
  return PFC_MAP[primary] ?? null;
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
