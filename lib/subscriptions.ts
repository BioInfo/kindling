import { db } from "./db";
import { plaid } from "./plaid";
import { decrypt } from "./crypto";
import { detectRecurring, isLapsed, norm } from "./recurring";
import { mapPfc, CATEGORIES } from "./taxonomy";
import { chat, extractJson } from "./llm";
import type { DatabaseSync } from "node:sqlite";

// ── Subscriptions: the curated cost-reduction layer over recurring detection ──
// Detection has two sources: Plaid's recurring-transaction streams (authoritative
// status + amounts, rides the `transactions` product, no re-link) and the local
// heuristic detectRecurring() (catches what Plaid misses and tags entity). Both
// feed reconcileSubscriptions(), which UPSERTS candidates into the subscriptions
// table while preserving every user-owned field (state, type, merchant rename,
// trial date, note, color/icon, entity). Detection only refreshes amount/date/
// status columns; it never resurrects a dismissed/cancelled row. Auto-populate:
// a newly-detected stream lands as state='active' immediately.

export type SubState = "active" | "trial" | "cancelled" | "dismissed";
export type SubType = "subscription" | "bill" | "membership" | "transfer" | null;
// Which list a row lands in. Ended = no charge in ~2 cycles, detection stopped
// finding it, or you cancelled it; ended rows are out of every total.
export type SubGroup = "subs" | "bills" | "transfers" | "ended";

export type PricePoint = { date: string; amount: number };
export type SubEnrichment = {
  displayName: string;
  group: SubGroup;
  svcGroup: string | null;          // finer service group (AI tools, Streaming…) for the donut + overlap
  perCycle: number;                 // total billed per cycle across every merged descriptor
  annual: number;
  accounts: { label: string; mask: string | null; institution: string | null; last: string }[];
  history: PricePoint[];            // per-cycle totals, oldest → newest
  lastChange: { date: string; from: number; to: number } | null;
  aliases: { id: string; merchant: string }[]; // descriptors merged into this row
  overlapWith: { id: string; merchant: string; label: string }[];
  possibleDupOf: { id: string; merchant: string } | null;
  unlabelled: boolean;              // no type yet (rules could not tell; the LLM pass may)
};

export type Subscription = SubEnrichment & {
  id: string;
  entity: string;
  merchant: string;
  merchantKey: string;
  category: string | null;
  type: SubType;
  cadence: string;
  intervalDays: number;
  avgAmount: number;
  lastAmount: number;
  monthly: number;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  nextExpected: string | null;
  isActive: boolean;
  priceChange: number;
  variableAmount: boolean;
  state: SubState;
  trialEnds: string | null;
  color: string | null;
  icon: string | null;
  note: string | null;
  workMove: string | null;   // null=personal | 'pending'=move to work card | 'moved'
  source: string;
  plaidStreamId: string | null;
  mergedInto: string | null;
  typeSource: string | null;      // user | rule | ai | legacy
  categorySource: string | null;
  userCadence: string | null;     // your cadence override (annual plan Plaid reads as monthly)
};

type Candidate = {
  entity: string;
  direction: "expense" | "income";
  merchantKey: string;
  merchant: string;
  category: string | null;
  cadence: string;
  intervalDays: number;
  avgAmount: number;
  lastAmount: number;
  monthly: number;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  nextExpected: string | null;
  isActive: boolean;
  priceChange: number;
  variableAmount: boolean;
  source: "plaid" | "heuristic";
  plaidStreamId: string | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}
function daysSince(date: string): number {
  return Math.round((+new Date(today() + "T00:00:00Z") - +new Date(date + "T00:00:00Z")) / 86400000);
}
const candId = (c: { entity: string; direction: string; merchantKey: string }) =>
  `${c.entity}:${c.direction}:${c.merchantKey}`;

// ── Schema (this surface owns its columns; db.ts owns the base table) ────────
// merged_into   another row's id: this descriptor is an alias of that service.
//               The row stays so reconcile keeps upserting it (that IS the alias
//               store) but it is hidden and its charges roll into the parent.
// merge_source  auto | user. merge_lock = 1 after an unmerge or "not a duplicate":
//               the auto pass never touches that row again.
// type_source / category_source  user | rule | ai | legacy. A user value always wins.
// user_cadence  your cadence override; detection's cadence is ignored when set.
const ensured = new WeakSet<DatabaseSync>();
export function ensureSubsSchema(): DatabaseSync {
  const d = db();
  if (ensured.has(d)) return d;
  const cols = new Set((d.prepare(`PRAGMA table_info(subscriptions)`).all() as { name: string }[]).map((c) => c.name));
  for (const [c, decl] of [
    ["merged_into", "TEXT"], ["merge_source", "TEXT"], ["merge_lock", "INTEGER NOT NULL DEFAULT 0"],
    ["type_source", "TEXT"], ["category_source", "TEXT"], ["user_cadence", "TEXT"],
  ] as const) if (!cols.has(c)) d.exec(`ALTER TABLE subscriptions ADD COLUMN ${c} ${decl}`);
  // Vocabulary moved from obligation/other to bill/transfer; 'other' carried no
  // information, so it re-enters labelling as unset. Rows typed before sources
  // were tracked are 'legacy' (could be yours, could be a rule).
  d.exec(`UPDATE subscriptions SET type = 'bill' WHERE type = 'obligation'`);
  d.exec(`UPDATE subscriptions SET type = NULL, type_source = NULL WHERE type = 'other' AND COALESCE(type_source,'') != 'user'`);
  d.exec(`UPDATE subscriptions SET type_source = 'legacy' WHERE type IS NOT NULL AND type_source IS NULL`);
  d.exec(`UPDATE subscriptions SET category_source = 'legacy' WHERE category IS NOT NULL AND category_source IS NULL`);
  ensured.add(d);
  return d;
}

// ── Deterministic labelling: a brand registry ────────────────────────────────
// One entry per service: the merge key (brand), the type, a taxonomy category,
// a finer service group, and an overlap family (two live members = "possible
// overlap"). noMerge = the brand alone does not identify one stream (two Zelle
// recipients are two transfers). annual = an annual fee even on one charge.
type Brand = {
  re: RegExp; brand: string; label?: string; type: Exclude<SubType, null>; category: string;
  group: string; overlap?: string; noMerge?: boolean; annual?: boolean;
};
const S = "subscription", B = "bill", M = "membership", T = "transfer";
const BRANDS: Brand[] = [
  // Transfers & savings — money moved, not spent.
  { re: /zelle/, brand: "zelle", type: T, category: "Transfer:P2P", group: "Family & P2P", noMerge: true },
  { re: /venmo/, brand: "venmo", type: T, category: "Transfer:P2P", group: "Family & P2P", noMerge: true },
  { re: /apple cash sent|cash app|square cash|paypal.*(transfer|sent)/, brand: "p2p", type: T, category: "Transfer:P2P", group: "Family & P2P", noMerge: true },
  { re: /greenlight/, brand: "greenlight", label: "Greenlight", type: T, category: "Transfer:P2P", group: "Family & P2P" },
  { re: /invest ?529|\b529\b/, brand: "529", label: "529 plan", type: T, category: "Transfer:Brokerage", group: "Savings & investing" },
  { re: /fundrise/, brand: "fundrise", label: "Fundrise", type: T, category: "Transfer:Brokerage", group: "Savings & investing" },
  { re: /prosper/, brand: "prosper", label: "Prosper", type: T, category: "Transfer:Brokerage", group: "Savings & investing" },
  { re: /robinhood|vanguard|fidelity|schwab|betterment|wealthfront|acorns|coinbase|\bbrokerage\b/, brand: "brokerage", type: T, category: "Transfer:Brokerage", group: "Savings & investing", noMerge: true },
  { re: /^invest$|^invest /, brand: "invest", type: T, category: "Transfer:Brokerage", group: "Savings & investing", noMerge: true },
  { re: /ext trnsfr|external transfer|online transfer|transfer to /, brand: "ext-transfer", type: T, category: "Transfer:Internal", group: "Savings & investing", noMerge: true },
  // Housing, loans, insurance, utilities, government.
  { re: /pennymac/, brand: "pennymac", label: "PennyMac mortgage", type: B, category: "Mortgage", group: "Housing" },
  { re: /mortgage|mr\.? cooper|rocket mortgage/, brand: "mortgage", type: B, category: "Mortgage", group: "Housing", noMerge: true },
  { re: /motor finance|auto loan|financial services|car loan/, brand: "auto-loan", type: B, category: "Transportation", group: "Loans" },
  { re: /\bloan\b/, brand: "loan", type: B, category: "Other", group: "Loans", noMerge: true },
  { re: /usaa p ?c|usaa pc|geico|state farm|progressive|allstate|liberty mutual/, brand: "auto-home-insurance", type: B, category: "Insurance", group: "Insurance" },
  { re: /prudent pet|trupanion|pet insur|lemonade/, brand: "pet-insurance", label: "Prudent Pet insurance", type: B, category: "Insurance", group: "Insurance" },
  { re: /insurance|insu /, brand: "insurance", type: B, category: "Insurance", group: "Insurance", noMerge: true },
  { re: /verizon|vzwrlss/, brand: "verizon", label: "Verizon", type: B, category: "Utilities", group: "Phone & internet" },
  { re: /comcast|xfinity|at ?t\b|t-?mobile|starlink|cox comm/, brand: "telecom", type: B, category: "Utilities", group: "Phone & internet", noMerge: true },
  { re: /water|dominion|novec|washington gas|electric|pepco/, brand: "utility", type: B, category: "Utilities", group: "Utilities", noMerge: true },
  { re: /ez ?pass|e-?zpass|driveez|drive ?ez|\btolls?\b|tollway|turnpike|sunpass|fastrak/, brand: "tolls", label: "Tolls (E-ZPass)", type: B, category: "Transportation", group: "Transport" },
  { re: /\bdmv\b|motor vehicle/, brand: "dmv", type: B, category: "Fees", group: "Transport" },
  { re: /tax withheld|\birs\b|\btax\b/, brand: "tax", type: B, category: "Taxes", group: "Taxes", noMerge: true },
  { re: /education|tuition|school/, brand: "education", type: B, category: "Education", group: "Education", noMerge: true },
  { re: /\bro health\b|hims|hers/, brand: "ro", label: "Ro", type: M, category: "Healthcare", group: "Health" },
  { re: /therapy|medical|pharmacy|walgreens|\bcvs\b|dental|clinic|hospital|animal medical|\bvet\b/, brand: "health", type: B, category: "Healthcare", group: "Health", noMerge: true },
  // Card annual fees: yearly by nature, a membership you can downgrade.
  { re: /(amex|american express).*(membership|renewal|annual)|renewal membership fee|annual membership fee|annual fee/, brand: "card-fee", type: M, category: "Fees", group: "Card fees", annual: true, noMerge: true },
  // AI tools.
  { re: /anthropic|claude/, brand: "anthropic", label: "Anthropic (Claude)", type: S, category: "Subscriptions", group: "AI tools", overlap: "AI chat" },
  { re: /openai|chatgpt/, brand: "openai", label: "OpenAI (ChatGPT)", type: S, category: "Subscriptions", group: "AI tools", overlap: "AI chat" },
  { re: /grok|\bxai\b|x\.ai/, brand: "grok", label: "Grok (xAI)", type: S, category: "Subscriptions", group: "AI tools", overlap: "AI chat" },
  { re: /perplexity|gemini|mistral/, brand: "ai-other", type: S, category: "Subscriptions", group: "AI tools", overlap: "AI chat", noMerge: true },
  { re: /elevenlabs/, brand: "elevenlabs", label: "ElevenLabs", type: S, category: "Subscriptions", group: "AI tools" },
  { re: /midjourney|cursor|github|copilot/, brand: "dev-ai", type: S, category: "Subscriptions", group: "AI tools", noMerge: true },
  // Cloud & dev.
  { re: /vercel/, brand: "vercel", label: "Vercel", type: S, category: "Subscriptions", group: "Cloud & dev", overlap: "Hosting" },
  { re: /hetzner/, brand: "hetzner", label: "Hetzner", type: S, category: "Subscriptions", group: "Cloud & dev", overlap: "Hosting" },
  { re: /exe ?\.? ?dev|exedev|bold software|^e dev\b/, brand: "exe.dev", label: "exe.dev", type: S, category: "Subscriptions", group: "Cloud & dev", overlap: "Hosting" },
  { re: /cloudflare/, brand: "cloudflare", label: "Cloudflare", type: S, category: "Subscriptions", group: "Cloud & dev" },
  { re: /backblaze/, brand: "backblaze", label: "Backblaze", type: S, category: "Subscriptions", group: "Cloud storage", overlap: "Cloud storage" },
  { re: /resend/, brand: "resend", label: "Resend", type: S, category: "Subscriptions", group: "Cloud & dev" },
  { re: /x developer/, brand: "x-api", label: "X API", type: S, category: "Subscriptions", group: "Cloud & dev" },
  { re: /quantconnect|quiver quant/, brand: "quant-data", type: S, category: "Subscriptions", group: "Market data", noMerge: true },
  // Software & productivity.
  { re: /microsoft|msft/, brand: "microsoft", label: "Microsoft 365", type: S, category: "Subscriptions", group: "Software", overlap: "Office suite" },
  { re: /google ?workspace|google work|workspace ?embe|gsuite/, brand: "google-workspace", label: "Google Workspace", type: S, category: "Subscriptions", group: "Software", overlap: "Office suite" },
  { re: /google ?one|google storage/, brand: "google-one", label: "Google One", type: S, category: "Subscriptions", group: "Cloud storage", overlap: "Cloud storage" },
  { re: /icloud|dropbox/, brand: "storage", type: S, category: "Subscriptions", group: "Cloud storage", overlap: "Cloud storage", noMerge: true },
  { re: /zoom/, brand: "zoom", label: "Zoom", type: S, category: "Subscriptions", group: "Software" },
  { re: /obsidian/, brand: "obsidian", label: "Obsidian", type: S, category: "Subscriptions", group: "Software" },
  { re: /buffer/, brand: "buffer", label: "Buffer", type: S, category: "Subscriptions", group: "Software" },
  { re: /notion|1password|adobe|canva|grammarly/, brand: "software", type: S, category: "Subscriptions", group: "Software", noMerge: true },
  { re: /apple ?\.? ?com ?\/? ?bill|applecombill|^apple$|^apple /, brand: "apple", label: "Apple services", type: S, category: "Subscriptions", group: "Software" },
  // Media.
  { re: /netflix|hulu|peacock|disney|paramount|\bmax\b|hbo|youtube|appletv|apple tv/, brand: "video", type: S, category: "Entertainment", group: "Streaming", overlap: "Video streaming", noMerge: true },
  { re: /spotify|apple music|tidal|pandora|sirius/, brand: "music", type: S, category: "Entertainment", group: "Music", overlap: "Music", noMerge: true },
  { re: /audible/, brand: "audible", label: "Audible", type: S, category: "Entertainment", group: "Reading & audio", overlap: "Books & audio" },
  { re: /kindle/, brand: "kindle", label: "Kindle", type: S, category: "Entertainment", group: "Reading & audio", overlap: "Books & audio" },
  { re: /new york times|nytimes|\bnyt\b|wsj|washington post|economist|substack/, brand: "news", type: S, category: "Subscriptions", group: "News", noMerge: true },
  { re: /x corp|^x$|^x |twitter/, brand: "x", label: "X Premium", type: S, category: "Subscriptions", group: "Social" },
  // Memberships and other.
  { re: /amazon prime|prime video|primevideo/, brand: "amazon-prime", label: "Amazon Prime", type: M, category: "Shopping", group: "Memberships" },
  { re: /costco|sam'?s club|\baaa\b|bj'?s wholesale/, brand: "warehouse", type: M, category: "Shopping", group: "Memberships", noMerge: true },
  { re: /recreation|ymca|\bgym\b|fitness|peloton/, brand: "fitness", type: M, category: "Entertainment", group: "Fitness & rec", noMerge: true },
  { re: /uber/, brand: "uber", label: "Uber", type: S, category: "Transportation", group: "Transport" },
  { re: /chewy/, brand: "chewy", label: "Chewy", type: S, category: "Shopping", group: "Pet" },
];

export function matchBrand(merchant: string, key = ""): Brand | null {
  const text = `${merchant.toLowerCase()} | ${key}`;
  for (const b of BRANDS) {
    // Anchored patterns test each side separately (^x$ must not match "x | x corp").
    if (b.re.test(merchant.toLowerCase()) || (key && b.re.test(key))) return b;
    if (!b.re.source.includes("^") && b.re.test(text)) return b;
  }
  return null;
}

// Raw Plaid primaries that leak into a sub's category, mapped by type.
const TAXO = new Set<string>(CATEGORIES);
function categoryForType(type: SubType, raw: string | null): string {
  if (raw && TAXO.has(raw) && !(type === "transfer" && !raw.startsWith("Transfer"))) return raw;
  if (type === "transfer") return raw === "TRANSFER_OUT" ? "Transfer:P2P" : "Transfer:Internal";
  if (type === "bill") return raw === "Bills" ? "Utilities" : raw === "LOAN_PAYMENTS" ? "Other" : "Other";
  return "Subscriptions";
}

// Rule label for one row: the brand registry first, then the Plaid category as a
// hint. type null = the rules cannot tell (left for the LLM pass, shown as a
// subscription meanwhile).
export function ruleLabel(merchant: string, key: string, category: string | null): { type: SubType; category: string | null; brand: Brand | null } {
  const b = matchBrand(merchant, key);
  if (b) return { type: b.type, category: b.category, brand: b };
  const c = category ?? "";
  if (c.startsWith("Transfer") || c === "TRANSFER_OUT") return { type: "transfer", category: categoryForType("transfer", c), brand: null };
  if (["Mortgage", "Rent", "Insurance", "Utilities", "Taxes", "Healthcare", "Education", "Bills", "LOAN_PAYMENTS"].includes(c))
    return { type: "bill", category: categoryForType("bill", c), brand: null };
  if (c === "Subscriptions" || c === "GENERAL_SERVICES") return { type: "subscription", category: "Subscriptions", brand: null };
  return { type: null, category: TAXO.has(c) ? c : null, brand: null };
}

const ANNUAL_RE = /annual|renewal|yearly/i;

// Insert-time type for a newly detected row: the rule label, plus the old
// obligation net (autopays, payroll, mortgage-scale amounts) as bills.
const BILL_RE = /autopay|e[\s-]?payment|ach\s*pmt|credit crd|cred crd|payroll|\b401k\b/i;
function classifyType(category: string | null, merchant: string, monthly: number): SubType {
  const r = ruleLabel(merchant, norm(merchant), category);
  if (r.type) return r.type;
  if (BILL_RE.test(merchant) || monthly >= 1000) return "bill";
  return null;
}

// Plaid recurring frequency → our cadence + a representative interval in days.
function freqToCadence(freq: string | undefined): { cadence: string; intervalDays: number } {
  switch (freq) {
    case "WEEKLY": return { cadence: "weekly", intervalDays: 7 };
    case "BIWEEKLY": return { cadence: "biweekly", intervalDays: 14 };
    case "SEMI_MONTHLY": return { cadence: "semimonthly", intervalDays: 15 };
    case "MONTHLY": return { cadence: "monthly", intervalDays: 30 };
    case "ANNUALLY": return { cadence: "yearly", intervalDays: 365 };
    default: return { cadence: "monthly", intervalDays: 30 };
  }
}

// ── Detection sources ───────────────────────────────────────────────────────

// Plaid recurring streams across every healthy item. Whole-portfolio (Plaid has
// no notion of our personal/business entity); entity is resolved later by matching
// to a heuristic candidate, defaulting to personal. Best-effort per item: a fresh
// link returns PRODUCT_NOT_READY / RECURRING_TRANSACTIONS_NOT_READY until streams
// mature — that item is skipped, never fatal, and the heuristic still covers it.
async function pullPlaidRecurring(): Promise<Candidate[]> {
  const items = db().prepare(`SELECT access_token FROM items WHERE status != 'error'`).all() as {
    access_token: string;
  }[];
  const out: Candidate[] = [];

  for (const item of items) {
    let accessToken: string;
    try { accessToken = decrypt(item.access_token); } catch { continue; }
    try {
      const res = await plaid.transactionsRecurringGet({ access_token: accessToken });
      const streams = [
        ...(res.data.outflow_streams ?? []).map((s) => ({ s, direction: "expense" as const })),
        ...(res.data.inflow_streams ?? []).map((s) => ({ s, direction: "income" as const })),
      ];
      for (const { s, direction } of streams) {
        const name = (s.merchant_name || s.description || "").trim();
        const key = norm(name);
        if (!key) continue;
        const { cadence, intervalDays } = freqToCadence(s.frequency as unknown as string);
        const avg = Math.abs(s.average_amount?.amount ?? 0);
        const last = Math.abs(s.last_amount?.amount ?? avg);
        if (avg <= 0) continue;
        const lastDate = s.last_date ?? null;
        out.push({
          entity: "personal", // resolved against heuristic candidates in reconcile
          direction,
          merchantKey: key,
          merchant: name,
          category: mapPfc(s.personal_finance_category?.primary) ?? null,
          cadence,
          intervalDays,
          avgAmount: round2(avg),
          lastAmount: round2(last),
          monthly: round2(avg * (30.44 / intervalDays)),
          count: s.transaction_ids?.length ?? 0,
          firstDate: s.first_date ?? null,
          lastDate,
          nextExpected: lastDate ? addDays(lastDate, intervalDays) : null,
          isActive: s.is_active ?? true,
          priceChange: round2(last - avg),
          variableAmount: false,
          source: "plaid",
          plaidStreamId: s.stream_id ?? null,
        });
      }
    } catch { /* stream not ready / item error — heuristic covers it */ }
  }
  return out;
}

// Heuristic candidates, tagged per entity (detectRecurring scopes by entity).
function heuristicCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const entity of ["personal", "business"]) {
    for (const r of detectRecurring({ entity })) {
      // No is_active from the heuristic: treat a stream as active if its last
      // charge is within ~2 cycles (plus a week of slack).
      const active = daysSince(r.lastDate) <= r.intervalDays * 2 + 7;
      out.push({
        entity,
        direction: r.direction,
        merchantKey: norm(r.merchant),
        merchant: r.merchant,
        category: r.category,
        cadence: r.cadence,
        intervalDays: r.intervalDays,
        avgAmount: r.avgAmount,
        lastAmount: r.lastAmount,
        monthly: r.monthly,
        count: r.count,
        firstDate: r.firstDate,
        lastDate: r.lastDate,
        nextExpected: r.nextExpected,
        isActive: active,
        priceChange: r.priceChange,
        variableAmount: r.variableAmount,
        source: "heuristic",
        plaidStreamId: null,
      });
    }
  }
  return out;
}

// Map a median gap to a known cadence band, defaulting to monthly (most subs).
function inferCadence(days: number): { cadence: string; intervalDays: number } {
  const bands: [string, number, number][] = [
    ["weekly", 6, 8], ["biweekly", 12, 16], ["monthly", 26, 33], ["quarterly", 82, 98], ["yearly", 350, 380],
  ];
  for (const [name, lo, hi] of bands) if (days >= lo && days <= hi) return { cadence: name, intervalDays: Math.round(days) };
  return { cadence: "monthly", intervalDays: 30 };
}

// Category-seeded candidates: a charge YOU explicitly categorized "Subscriptions"
// is a strong human signal it's a subscription, even before the recurrence
// heuristic has the 3 charges it needs (a brand-new Anthropic / exe.dev bill has
// only one). Seed those onto the surface so a user-categorized subscription shows
// up immediately; cadence is inferred from the gaps if there's more than one
// charge, else assumed monthly (the user can fix it in the detail modal). Keyed
// the SAME way detection keys, so once real recurrence is detected the rows merge
// rather than duplicate, and a later dismiss/cancel survives.
function categorySeededCandidates(): Candidate[] {
  const rows = db().prepare(
    `SELECT date, COALESCE(merchant, name) AS merchant, amount, entity
     FROM transactions
     WHERE category = 'Subscriptions' AND amount > 0 AND COALESCE(merchant, name) IS NOT NULL
       AND date >= date('now','-400 days')
     ORDER BY date ASC`
  ).all() as { date: string; merchant: string; amount: number; entity: string }[];

  const groups = new Map<string, { entity: string; merchant: string; dates: string[]; amts: number[] }>();
  for (const r of rows) {
    const key = norm(r.merchant);
    if (!key) continue;
    const id = `${r.entity}:${key}`;
    let g = groups.get(id);
    if (!g) { g = { entity: r.entity, merchant: r.merchant, dates: [], amts: [] }; groups.set(id, g); }
    g.dates.push(r.date); g.amts.push(Math.abs(r.amount));
  }

  const out: Candidate[] = [];
  for (const g of groups.values()) {
    let intervalDays = 30, cadence = "monthly";
    if (g.dates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < g.dates.length; i++)
        gaps.push((+new Date(g.dates[i] + "T00:00:00Z") - +new Date(g.dates[i - 1] + "T00:00:00Z")) / 86400000);
      const gap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      ({ cadence, intervalDays } = inferCadence(gap));
    }
    const avg = round2(g.amts.reduce((s, x) => s + x, 0) / g.amts.length);
    const lastDate = g.dates[g.dates.length - 1];
    const lastAmt = round2(g.amts[g.amts.length - 1]);
    out.push({
      entity: g.entity, direction: "expense",
      merchantKey: norm(g.merchant), merchant: g.merchant, category: "Subscriptions",
      cadence, intervalDays, avgAmount: avg, lastAmount: lastAmt,
      monthly: round2(avg * (30.44 / intervalDays)), count: g.dates.length,
      firstDate: g.dates[0], lastDate, nextExpected: addDays(lastDate, intervalDays),
      isActive: daysSince(lastDate) <= intervalDays * 2 + 7,
      priceChange: round2(lastAmt - avg), variableAmount: false,
      source: "heuristic", plaidStreamId: null,
    });
  }
  return out;
}

// ── Reconcile (the upsert) ──────────────────────────────────────────────────

// Merge both sources and upsert. Plaid wins on amount/status/cadence when a
// stream exists; the heuristic supplies entity and variable-amount flagging.
// User-owned columns are never overwritten (state/type/merchant/note/trial_ends/
// color/icon stay; category backfills via COALESCE then is user-owned).
export async function reconcileSubscriptions(opts: { plaid?: boolean } = {}): Promise<void> {
  const merged = new Map<string, Candidate>();
  for (const c of heuristicCandidates()) merged.set(candId(c), c);

  // Fill in user-categorized "Subscriptions" charges the recurrence heuristic
  // didn't catch yet (too few charges). Heuristic/Plaid data wins where it exists.
  for (const c of categorySeededCandidates()) {
    const key = candId(c);
    if (!merged.has(key)) merged.set(key, c);
  }

  let plaidRan = false; // a pass where every item failed must not end every Plaid row
  if (opts.plaid) {
    const streams = await pullPlaidRecurring();
    plaidRan = streams.length > 0;
    for (const p of streams) {
      // Find the entity a heuristic candidate already assigned to this stream
      // (try both entities); default personal if Plaid found it but we didn't.
      const personalKey = candId({ entity: "personal", direction: p.direction, merchantKey: p.merchantKey });
      const jsKey = candId({ entity: "business", direction: p.direction, merchantKey: p.merchantKey });
      const targetKey = merged.has(personalKey) ? personalKey : merged.has(jsKey) ? jsKey : personalKey;
      const existing = merged.get(targetKey);
      if (existing) {
        // Plaid is authoritative on amount/status/cadence; keep the heuristic's
        // entity + variable-amount flag.
        merged.set(targetKey, {
          ...existing,
          cadence: p.cadence,
          intervalDays: p.intervalDays,
          avgAmount: p.avgAmount,
          lastAmount: p.lastAmount,
          monthly: p.monthly,
          count: Math.max(existing.count, p.count),
          firstDate: p.firstDate ?? existing.firstDate,
          lastDate: p.lastDate ?? existing.lastDate,
          nextExpected: p.nextExpected ?? existing.nextExpected,
          isActive: p.isActive,
          priceChange: p.priceChange,
          category: existing.category ?? p.category,
          source: "plaid",
          plaidStreamId: p.plaidStreamId,
        });
      } else {
        merged.set(candId(p), p);
      }
    }
  }

  const ins = db().prepare(
    `INSERT INTO subscriptions
       (id, entity, merchant_key, merchant, plaid_stream_id, source, direction, type, category,
        cadence, interval_days, avg_amount, last_amount, monthly, count,
        first_date, last_date, next_expected, is_active, price_change, variable_amount,
        state, created_at, updated_at)
     VALUES
       (@id, @entity, @merchant_key, @merchant, @plaid_stream_id, @source, @direction, @type, @category,
        @cadence, @interval_days, @avg_amount, @last_amount, @monthly, @count,
        @first_date, @last_date, @next_expected, @is_active, @price_change, @variable_amount,
        'active', datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
        merchant_key = excluded.merchant_key,
        plaid_stream_id = COALESCE(excluded.plaid_stream_id, subscriptions.plaid_stream_id),
        source = excluded.source,
        type = COALESCE(subscriptions.type, excluded.type),
        category = COALESCE(subscriptions.category, excluded.category),
        cadence = excluded.cadence,
        interval_days = excluded.interval_days,
        avg_amount = excluded.avg_amount,
        last_amount = excluded.last_amount,
        monthly = excluded.monthly,
        count = excluded.count,
        first_date = COALESCE(subscriptions.first_date, excluded.first_date),
        last_date = excluded.last_date,
        next_expected = excluded.next_expected,
        is_active = excluded.is_active,
        price_change = excluded.price_change,
        variable_amount = excluded.variable_amount,
        updated_at = datetime('now')`
  );

  ensureSubsSchema();
  for (const c of merged.values()) {
    // An annual fee (card renewal, yearly plan) seen once or twice reads as
    // monthly to every detector: one charge has no gap, so it defaults. A $895
    // renewal then counts $908/mo. Name or brand says yearly → yearly.
    if (c.cadence !== "yearly" && c.count <= 2 && (ANNUAL_RE.test(c.merchant) || matchBrand(c.merchant, c.merchantKey)?.annual)) {
      c.cadence = "yearly"; c.intervalDays = 365;
      c.monthly = round2(c.avgAmount * (30.44 / 365));
      if (c.lastDate) c.nextExpected = addDays(c.lastDate, 365);
      c.isActive = !!c.lastDate && daysSince(c.lastDate) <= 365 * 2 + 7;
    }
    ins.run({
      id: candId(c),
      entity: c.entity,
      merchant_key: c.merchantKey,
      merchant: c.merchant,
      plaid_stream_id: c.plaidStreamId,
      source: c.source,
      direction: c.direction,
      type: classifyType(c.category, c.merchant, c.monthly),
      category: c.category,
      cadence: c.cadence,
      interval_days: c.intervalDays,
      avg_amount: c.avgAmount,
      last_amount: c.lastAmount,
      monthly: c.monthly,
      count: c.count,
      first_date: c.firstDate,
      last_date: c.lastDate,
      next_expected: c.nextExpected,
      is_active: c.isActive ? 1 : 0,
      price_change: c.priceChange,
      variable_amount: c.variableAmount ? 1 : 0,
    });
  }

  // A row this pass no longer finds has stopped (cancelled, moved to another
  // descriptor, or was never a stream). Upsert only rewrites found rows, so
  // without this it stayed "active" forever. Plaid-sourced rows end only on a
  // pass that asked Plaid; manual rows are yours and never end here.
  const found = [...merged.values()].map((c) => candId(c));
  const d = db();
  d.exec(`CREATE TEMP TABLE IF NOT EXISTS _subs_found (id TEXT PRIMARY KEY)`);
  d.exec(`DELETE FROM _subs_found`);
  const put = d.prepare(`INSERT OR IGNORE INTO _subs_found (id) VALUES (?)`);
  for (const id of found) put.run(id);
  d.prepare(
    `UPDATE subscriptions SET is_active = 0
     WHERE is_active = 1 AND source != 'manual' AND id NOT IN (SELECT id FROM _subs_found)
       AND (source != 'plaid' OR ? = 1)`
  ).run(plaidRan ? 1 : 0);
}

// ── Read side ───────────────────────────────────────────────────────────────

type SubRow = {
  id: string; entity: string; merchant: string; merchant_key: string; direction: string; category: string | null;
  type: string | null; cadence: string | null; interval_days: number | null;
  avg_amount: number; last_amount: number; monthly: number; count: number;
  first_date: string | null; last_date: string | null; next_expected: string | null;
  is_active: number; price_change: number; variable_amount: number;
  state: string; trial_ends: string | null; color: string | null; icon: string | null;
  note: string | null; work_move: string | null; source: string; plaid_stream_id: string | null;
  merged_into: string | null; merge_source: string | null; merge_lock: number;
  type_source: string | null; category_source: string | null; user_cadence: string | null;
};

const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30, quarterly: 91, yearly: 365 };

type BaseSub = Omit<Subscription, keyof SubEnrichment>;
function toBase(r: SubRow): BaseSub {
  const uc = r.user_cadence && CADENCE_DAYS[r.user_cadence] ? r.user_cadence : null;
  const intervalDays = uc ? CADENCE_DAYS[uc] : r.interval_days ?? 30;
  return {
    id: r.id, entity: r.entity, merchant: r.merchant, merchantKey: r.merchant_key,
    category: r.category, type: (r.type as SubType) ?? null,
    cadence: uc ?? r.cadence ?? "monthly", intervalDays,
    avgAmount: r.avg_amount, lastAmount: r.last_amount,
    monthly: uc ? round2(r.avg_amount * (30.44 / intervalDays)) : r.monthly, count: r.count,
    firstDate: r.first_date, lastDate: r.last_date, nextExpected: r.next_expected,
    isActive: !!r.is_active, priceChange: r.price_change, variableAmount: !!r.variable_amount,
    state: (r.state as SubState), trialEnds: r.trial_ends, color: r.color, icon: r.icon,
    note: r.note, workMove: r.work_move, source: r.source, plaidStreamId: r.plaid_stream_id,
    mergedInto: r.merged_into, typeSource: r.type_source, categorySource: r.category_source, userCadence: uc,
  };
}

export type SubMemberTxn = {
  id: string; date: string; name: string; merchant: string | null; amount: number;
  currency: string | null; category: string | null; entity: string;
  account: string; account_mask: string | null; account_institution: string | null;
};

// Every charge in the detection window, indexed by BOTH keys a row can carry:
// norm(displayed merchant) and norm(raw descriptor). merchant_key came from one
// of them at detection time, and a later rename must not orphan the history.
type TxnIndex = Map<string, SubMemberTxn[]>;
function loadTxnIndex(direction: "expense" | "income"): TxnIndex {
  const rows = db().prepare(
    `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.currency, t.category, t.entity,
            a.name AS account, a.mask AS account_mask,
            COALESCE(i.institution_name, i.institution) AS account_institution
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN items i ON i.id = a.item_id
     WHERE ${direction === "expense" ? "t.amount > 0" : "t.amount < 0"}
       AND COALESCE(t.merchant, t.name) IS NOT NULL AND t.date >= date('now','-400 days')
     ORDER BY t.date ASC`
  ).all() as unknown as SubMemberTxn[];
  const idx: TxnIndex = new Map();
  const push = (k: string, t: SubMemberTxn) => { if (!k) return; const a = idx.get(k); if (a) a.push(t); else idx.set(k, [t]); };
  for (const t of rows) {
    const a = norm(t.merchant || t.name), b = norm(t.name ?? "");
    push(a, t); if (b !== a) push(b, t);
  }
  return idx;
}
function ownTxns(idx: TxnIndex, r: { merchant_key: string; entity: string }): SubMemberTxn[] {
  return (idx.get(r.merchant_key) ?? []).filter((t) => (t.entity ?? "personal") === r.entity);
}
function unionTxns(lists: SubMemberTxn[][]): SubMemberTxn[] {
  const m = new Map<string, SubMemberTxn>();
  for (const l of lists) for (const t of l) m.set(t.id, t);
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const dayNum = (d: string) => Date.parse(d + "T00:00:00Z") / 86400000;

// The calendar length of a cadence. Detection's median gap is noisy (a monthly
// plan billed on the 6th and 8th reads as 26 days), and dividing by it inflates
// the monthly figure, so convert on the canonical length.
const CANON_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, semimonthly: 15.22, monthly: 30.44, quarterly: 91.31, yearly: 365.25 };
function cycleDays(cadence: string, interval: number): number {
  return CANON_DAYS[cadence] ?? Math.max(1, interval);
}

// Per-cycle totals. A service often bills several charges per cycle (two X
// accounts, a Workspace seat per user, Claude Max + Pro), and a merged row folds
// several descriptors together, so the honest amount is the SUM per cycle, not
// the mean charge. Cycles are anchored on the latest charge; perCycle averages
// the last three cycles (at least ~90 days for sub-monthly cadences, so a stream
// with two charges a month is not read off one lucky fortnight), counting a
// skipped cycle as zero.
function cycleStats(txns: SubMemberTxn[], interval: number) {
  const step = Math.max(1, interval);
  const last = txns[txns.length - 1].date;
  const buckets = new Map<number, { date: string; sum: number }>();
  for (const t of txns) {
    const i = Math.round((dayNum(last) - dayNum(t.date)) / step);
    const b = buckets.get(i);
    if (b) { b.sum += Math.abs(t.amount); if (t.date < b.date) b.date = t.date; }
    else buckets.set(i, { date: t.date, sum: Math.abs(t.amount) });
  }
  const maxI = Math.max(...buckets.keys());
  const k = Math.min(Math.max(3, Math.ceil(90 / step)), maxI + 1);
  let tot = 0;
  for (let i = 0; i < k; i++) tot += buckets.get(i)?.sum ?? 0;
  const history = [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, b]) => ({ date: b.date, amount: round2(b.sum) }));
  const amts = history.map((h) => h.amount);
  const mean = amts.reduce((a, x) => a + x, 0) / amts.length;
  const sd = Math.sqrt(amts.reduce((a, x) => a + (x - mean) ** 2, 0) / amts.length);
  const variable = amts.length >= 3 && mean > 0 && sd / mean > 0.25;
  let lastChange: { date: string; from: number; to: number } | null = null;
  // Two cycles cannot tell a price change from usage; a change needs three.
  if (!variable && history.length >= 3) {
    for (let i = history.length - 1; i > 0; i--) {
      const a = history[i - 1].amount, b = history[i].amount;
      if (Math.abs(b - a) > Math.max(0.5, a * 0.02)) { lastChange = { date: history[i].date, from: a, to: b }; break; }
    }
  }
  return { perCycle: round2(tot / k), history, variable, lastChange, first: txns[0].date, last };
}

// Merchant keys whose outflows are mostly credit-card payments or transfers
// between own accounts (the same categories detectRecurring skips). Plaid's
// recurring streams include card autopays; counting one as a bill double-counts
// every card charge behind it.
function movementKeys(): Set<string> {
  const rows = db().prepare(
    `SELECT COALESCE(merchant, name) AS m, category FROM transactions
     WHERE amount > 0 AND COALESCE(merchant, name) IS NOT NULL AND date >= date('now','-400 days')`
  ).all() as { m: string; category: string | null }[];
  const tally = new Map<string, { move: number; n: number }>();
  for (const r of rows) {
    const k = norm(r.m);
    const t = tally.get(k) ?? { move: 0, n: 0 };
    t.n++;
    if (r.category === "CreditCardPayment" || r.category === "Transfer:Internal") t.move++;
    tally.set(k, t);
  }
  return new Set([...tally].filter(([, t]) => t.move * 2 > t.n).map(([k]) => k));
}

// Raw descriptor look (ALL CAPS, store codes, a "*") → show the registry label
// instead; a name you typed, or a clean Plaid merchant name, stays as it is.
function displayNameFor(merchant: string, b: Brand | null): string {
  if (!b?.label) return merchant;
  const raw = merchant === merchant.toUpperCase() || /[#*]|\d{4,}/.test(merchant);
  return raw ? b.label : merchant;
}

// Build every visible row: fold merged aliases into their parent, recompute
// amounts from the union of member charges, and attach the enrichment.
function buildView(direction: "expense" | "income" = "expense"): { subs: Subscription[]; txnsOf: Map<string, SubMemberTxn[]> } {
  ensureSubsSchema();
  const rows = db().prepare(`SELECT * FROM subscriptions WHERE direction = ?`).all(direction) as unknown as SubRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const moves = direction === "expense" ? movementKeys() : new Set<string>();
  const idx = loadTxnIndex(direction);
  const root = (r: SubRow): SubRow => {
    let cur = r, guard = 0;
    while (cur.merged_into && byId.has(cur.merged_into) && guard++ < 10) cur = byId.get(cur.merged_into)!;
    return cur;
  };
  const kids = new Map<string, SubRow[]>();
  for (const r of rows) {
    if (!r.merged_into) continue;
    const p = root(r);
    if (p.id === r.id) continue;
    const a = kids.get(p.id); if (a) a.push(r); else kids.set(p.id, [r]);
  }

  const subs: Subscription[] = [];
  const txnsOf = new Map<string, SubMemberTxn[]>();
  for (const r of rows) {
    if (r.merged_into && root(r).id !== r.id) continue; // an alias, folded into its parent
    if (moves.has(r.merchant_key)) continue;
    const members = [r, ...(kids.get(r.id) ?? [])];
    const base = toBase(r);
    let txns = unionTxns(members.map((m) => ownTxns(idx, m)));
    // Over-broad key: a shop or wallet merchant (Amazon, Venmo) where the
    // detected stream is a few of many charges. Summing every charge would turn
    // one $6 plan into $785/mo, so keep detection's amounts and show only the
    // charges that match the stream's price.
    const detected = members.reduce((a, m) => a + (m.count || 0), 0);
    const overBroad = txns.length > detected * 2 + 3;
    if (overBroad) {
      const prices = members.flatMap((m) => [m.avg_amount, m.last_amount]).filter((x) => x > 0);
      txns = txns.filter((t) => prices.some((p) => Math.abs(Math.abs(t.amount) - p) <= Math.max(0.5, p * 0.1)));
    }
    txnsOf.set(r.id, txns);
    const brand = matchBrand(r.merchant, r.merchant_key);
    const hasKids = (kids.get(r.id) ?? []).length > 0;
    const s: Subscription = {
      ...base,
      // A merged row stands for the service, not one of its descriptors.
      displayName: hasKids && brand?.label ? brand.label : displayNameFor(r.merchant, brand),
      group: "subs", svcGroup: brand?.group ?? null,
      perCycle: base.avgAmount, annual: 0, accounts: [], history: [], lastChange: null,
      aliases: (kids.get(r.id) ?? []).map((k) => ({ id: k.id, merchant: k.merchant })),
      overlapWith: [], possibleDupOf: null, unlabelled: !base.type,
    };
    if (txns.length) {
      const cyc = cycleDays(s.cadence, s.intervalDays);
      const st = cycleStats(txns, cyc);
      s.history = st.history;
      s.lastChange = st.lastChange;
      s.variableAmount = st.variable || base.variableAmount;
      if (!overBroad) {
        s.perCycle = st.perCycle;
        s.monthly = round2(st.perCycle * (30.44 / cyc));
      }
      s.count = txns.length;
      s.firstDate = [st.first, ...members.map((m) => m.first_date)].filter(Boolean).sort()[0] as string;
      s.lastDate = st.last;
      s.lastAmount = round2(Math.abs(txns[txns.length - 1].amount));
      s.nextExpected = addDays(st.last, s.intervalDays);
      s.avgAmount = round2(txns.reduce((a, t) => a + Math.abs(t.amount), 0) / txns.length);
      s.priceChange = st.lastChange && st.lastChange.to > st.lastChange.from && daysSince(st.lastChange.date) <= 120
        ? round2(st.lastChange.to - st.lastChange.from) : 0;
      const acc = new Map<string, SubEnrichment["accounts"][number]>();
      for (const t of txns) acc.set(`${t.account}|${t.account_mask}`, { label: t.account, mask: t.account_mask, institution: t.account_institution, last: t.date });
      s.accounts = [...acc.values()].sort((a, b) => b.last.localeCompare(a.last));
    } else {
      s.perCycle = base.avgAmount;
      s.priceChange = 0;
    }
    s.annual = round2(s.monthly * 12);
    // Ended: every member stopped being detected, or the last charge is two
    // cycles old. Manual rows are yours: they end only when you cancel them.
    const anyFound = members.some((m) => m.is_active);
    const lapsed = s.lastDate ? isLapsed(s.lastDate, s.intervalDays) : false;
    s.isActive = r.source === "manual" && !txns.length ? true : anyFound && !lapsed;
    s.group = !s.isActive || s.state === "cancelled" ? "ended"
      : s.type === "transfer" ? "transfers" : s.type === "bill" ? "bills" : "subs";
    subs.push(s);
  }

  // Possible overlap: two live services from one family (two AI chats, Kindle
  // Unlimited + Audible, Microsoft 365 + Google Workspace).
  const fam = new Map<string, Subscription[]>();
  for (const s of subs) {
    if (s.group !== "subs" || s.state === "dismissed") continue;
    const b = matchBrand(s.merchant, s.merchantKey);
    if (!b?.overlap) continue;
    const a = fam.get(b.overlap); if (a) a.push(s); else fam.set(b.overlap, [s]);
  }
  for (const [label, ms] of fam) {
    if (new Set(ms.map((m) => matchBrand(m.merchant, m.merchantKey)?.brand)).size < 2) continue;
    for (const s of ms) s.overlapWith = ms.filter((o) => o.id !== s.id).map((o) => ({ id: o.id, merchant: o.displayName, label }));
  }

  // Possible duplicate: same brand, not merged, the auto pass lacked evidence
  // (or you said "not a duplicate", which locks the row and silences this).
  const brandRows = new Map<string, Subscription[]>();
  for (const s of subs) {
    if (s.state === "dismissed" || byId.get(s.id)!.merge_lock) continue;
    const b = matchBrand(s.merchant, s.merchantKey);
    if (!b || b.noMerge) continue;
    const a = brandRows.get(b.brand); if (a) a.push(s); else brandRows.set(b.brand, [s]);
  }
  for (const ms of brandRows.values()) {
    if (ms.length < 2) continue;
    const keep = [...ms].sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.monthly - a.monthly)[0];
    for (const s of ms) if (s.id !== keep.id) s.possibleDupOf = { id: keep.id, merchant: keep.displayName };
  }
  return { subs, txnsOf };
}

// Count how many charges a stream will incur in the next `days` days (handles
// weekly/biweekly streams that hit more than once).
function chargesInWindow(sub: Subscription, days: number): number {
  if (!sub.nextExpected || !sub.intervalDays) return 0;
  const end = addDays(today(), days);
  let n = 0, d = sub.nextExpected, guard = 0;
  while (d <= end && guard < 400) { if (d >= today()) n++; d = addDays(d, sub.intervalDays); guard++; }
  return n;
}

export type SubsView = {
  subs: Subscription[];                 // every visible expense row, each tagged with its group
  monthlyTotal: number;                 // the hero: live subscriptions + memberships only
  annualTotal: number;
  next30Total: number;
  billsMonthly: number; billsCount: number;
  transfersMonthly: number; transfersCount: number;
  endedCount: number;
  workMoveMonthly: number; workMoveCount: number;
  byCategory: { key: string; value: number; pct: number }[]; // hero rows by service group
  counts: { active: number; priceHikes: number; overlaps: number; duplicates: number; unlabelled: number };
};

const live = (s: Subscription) => s.state === "active" || s.state === "trial";

// Expense subscriptions for a surface. Income recurring stays in Transactions ›
// Recurring. The hero counts only live subscriptions and memberships; bills and
// transfers each carry their own subtotal; ended rows count nowhere.
export function listSubscriptions(entity?: string | null): SubsView {
  const all = buildView("expense").subs.filter((s) => s.state !== "dismissed");
  const subs = entity && entity !== "all" ? all.filter((s) => s.entity === entity) : all;
  const hero = subs.filter((s) => s.group === "subs" && live(s));
  const bills = subs.filter((s) => s.group === "bills" && live(s));
  const transfers = subs.filter((s) => s.group === "transfers" && live(s));
  const sum = (xs: Subscription[]) => round2(xs.reduce((a, x) => a + x.monthly, 0));
  const monthlyTotal = sum(hero);

  const catMap = new Map<string, number>();
  for (const s of hero) {
    const k = s.svcGroup ?? (s.category && s.category !== "Subscriptions" ? s.category : "Other services");
    catMap.set(k, (catMap.get(k) ?? 0) + s.monthly);
  }
  const byCategory = [...catMap.entries()]
    .map(([key, value]) => ({ key, value: round2(value), pct: monthlyTotal > 0 ? value / monthlyTotal : 0 }))
    .sort((a, b) => b.value - a.value);

  const toMove = subs.filter((s) => s.workMove === "pending" && s.isActive && live(s));
  return {
    subs,
    monthlyTotal,
    annualTotal: round2(monthlyTotal * 12),
    next30Total: round2(hero.reduce((a, x) => a + chargesInWindow(x, 30) * x.perCycle, 0)),
    billsMonthly: sum(bills), billsCount: bills.length,
    transfersMonthly: sum(transfers), transfersCount: transfers.length,
    endedCount: subs.filter((s) => s.group === "ended").length,
    workMoveMonthly: sum(toMove), workMoveCount: toMove.length,
    byCategory,
    counts: {
      active: hero.length,
      priceHikes: hero.filter((s) => s.priceChange > 0.5).length,
      overlaps: hero.filter((s) => s.overlapWith.length > 0).length,
      duplicates: subs.filter((s) => s.possibleDupOf).length,
      unlabelled: subs.filter((s) => s.unlabelled && s.group !== "ended").length,
    },
  };
}

// One subscription (an alias id resolves to its parent) + the union of member
// charges, plus the rows it could be merged into (same brand first).
export function getSubscription(id: string): {
  sub: Subscription; txns: SubMemberTxn[]; mergeTargets: { id: string; merchant: string; sameBrand: boolean }[];
} | null {
  ensureSubsSchema();
  const row = db().prepare(`SELECT id, direction, merged_into FROM subscriptions WHERE id = ?`).get(id) as { id: string; direction: string; merged_into: string | null } | undefined;
  if (!row) return null;
  const { subs, txnsOf } = buildView(row.direction === "income" ? "income" : "expense");
  let target = row.id, guard = 0, cur: { merged_into: string | null } | undefined = row;
  while (cur?.merged_into && guard++ < 10) {
    target = cur.merged_into;
    cur = db().prepare(`SELECT merged_into FROM subscriptions WHERE id = ?`).get(target) as { merged_into: string | null } | undefined;
  }
  const sub = subs.find((s) => s.id === target);
  if (!sub) return null;
  const b = matchBrand(sub.merchant, sub.merchantKey)?.brand;
  const mergeTargets = subs
    .filter((s) => s.id !== sub.id && s.state !== "dismissed")
    .map((s) => ({ id: s.id, merchant: s.displayName, sameBrand: !!b && matchBrand(s.merchant, s.merchantKey)?.brand === b }))
    .sort((a, b2) => Number(b2.sameBrand) - Number(a.sameBrand) || a.merchant.localeCompare(b2.merchant));
  return { sub, txns: txnsOf.get(sub.id) ?? [], mergeTargets };
}

// ── Merging descriptors into one service ────────────────────────────────────

function rootId(id: string): string {
  let cur = id, guard = 0;
  for (;;) {
    const r = db().prepare(`SELECT merged_into FROM subscriptions WHERE id = ?`).get(cur) as { merged_into: string | null } | undefined;
    if (!r?.merged_into || guard++ > 10) return cur;
    cur = r.merged_into;
  }
}

function setMerged(childId: string, parentId: string, source: "auto" | "user") {
  const d = db();
  d.prepare(`UPDATE subscriptions SET merged_into = ?, merge_source = ?, merge_lock = 0, updated_at = datetime('now') WHERE id = ?`).run(parentId, source, childId);
  d.prepare(`UPDATE subscriptions SET merged_into = ? WHERE merged_into = ?`).run(parentId, childId);
  // Your curation on the alias carries over where the parent has none.
  d.prepare(
    `UPDATE subscriptions SET
       note = COALESCE(note, (SELECT note FROM subscriptions WHERE id = @c)),
       work_move = COALESCE(work_move, (SELECT work_move FROM subscriptions WHERE id = @c)),
       color = COALESCE(color, (SELECT color FROM subscriptions WHERE id = @c)),
       icon = COALESCE(icon, (SELECT icon FROM subscriptions WHERE id = @c))
     WHERE id = @p`
  ).run({ c: childId, p: parentId });
}

// "Merge into…": you pick the parent. Reconcile never undoes it.
export function mergeSubscription(childId: string, parentId: string): boolean {
  ensureSubsSchema();
  const p = rootId(parentId);
  if (p === childId || rootId(childId) === p) return false;
  const exists = db().prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE id IN (?, ?)`).get(childId, p) as { n: number };
  if (exists.n < 2) return false;
  setMerged(childId, p, "user");
  return true;
}

// Unmerge an alias back into its own row, and lock it so the auto pass never
// re-merges it. Same lock as "not a duplicate".
export function unmergeSubscription(childId: string): boolean {
  ensureSubsSchema();
  const r = db().prepare(
    `UPDATE subscriptions SET merged_into = NULL, merge_source = NULL, merge_lock = 1, updated_at = datetime('now') WHERE id = ? AND merged_into IS NOT NULL`
  ).run(childId);
  return Number(r.changes ?? 0) > 0;
}
export function markNotDuplicate(id: string): boolean {
  ensureSubsSchema();
  return Number(db().prepare(`UPDATE subscriptions SET merge_lock = 1 WHERE id = ?`).run(id).changes ?? 0) > 0;
}

// Automatic merge of one service seen under several descriptors. Only on strong
// evidence, within one entity and one brand (never a noMerge brand, never a
// locked or dismissed row):
//   shared   the two rows' member charges overlap (the same charge under two keys)
//   twin     one row has no charges of its own (a Plaid stream) and matches the
//            other's cadence and amount within 5% over overlapping dates
//   handoff  one stream stops as the other starts, at a similar amount
// Two plans of one brand both running at different amounts fail all three and
// are left as "possible duplicate" for a one-tap merge.
export function autoMergeSubscriptions(): { merged: { child: string; parent: string; why: string }[] } {
  ensureSubsSchema();
  const d = db();
  const rows = d.prepare(
    `SELECT * FROM subscriptions WHERE direction = 'expense' AND state != 'dismissed' AND merged_into IS NULL AND merge_lock = 0`
  ).all() as unknown as SubRow[];
  const childRows = d.prepare(`SELECT * FROM subscriptions WHERE merged_into IS NOT NULL`).all() as unknown as SubRow[];
  const idx = loadTxnIndex("expense");
  const info = rows.map((r) => {
    const kids = childRows.filter((k) => rootId(k.id) === r.id);
    const txns = unionTxns([r, ...kids].map((m) => ownTxns(idx, m)));
    const amts = txns.length ? txns.map((t) => Math.abs(t.amount)) : [r.avg_amount];
    return {
      r, brand: matchBrand(r.merchant, r.merchant_key), ids: new Set(txns.map((t) => t.id)), amts,
      first: txns[0]?.date ?? r.first_date, last: txns[txns.length - 1]?.date ?? r.last_date, n: txns.length,
    };
  });
  type Info = (typeof info)[number];
  const similar = (a: Info, b: Info) =>
    a.amts.some((x) => b.amts.some((y) => Math.abs(x - y) <= Math.max(1, 0.2 * Math.max(x, y))));
  const evidence = (a: Info, b: Info): string | null => {
    // The same charge under two keys is one stream whatever the brand says
    // (noMerge only stops brand-level guessing, e.g. two Zelle recipients).
    for (const id of a.ids) if (b.ids.has(id)) return "shared";
    if (!a.brand || a.brand.noMerge || a.brand.brand !== b.brand?.brand) return null;
    const iv = Math.max(a.r.interval_days ?? 30, b.r.interval_days ?? 30);
    if ((a.n === 0 || b.n === 0) && a.r.cadence === b.r.cadence
      && Math.abs(a.r.avg_amount - b.r.avg_amount) <= 0.05 * Math.max(a.r.avg_amount, b.r.avg_amount)
      && a.first && b.first && a.last && b.last && a.first <= b.last && b.first <= a.last) return "twin";
    if (a.first && b.first && a.last && b.last && similar(a, b)) {
      const [x, y] = a.last <= b.last ? [a, b] : [b, a];
      if (dayNum(x.last!) <= dayNum(y.first!) + iv / 2) return "handoff";
    }
    return null;
  };

  // Union-find over strong edges, within one entity.
  const parent = new Map<string, string>(rows.map((r) => [r.id, r.id]));
  const find = (x: string): string => { while (parent.get(x) !== x) x = parent.get(x)!; return x; };
  const why = new Map<string, string>();
  const buckets = new Map<string, Info[]>();
  for (const i of info) {
    const a = buckets.get(i.r.entity); if (a) a.push(i); else buckets.set(i.r.entity, [i]);
  }
  for (const ms of buckets.values()) {
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
      const e = evidence(ms[i], ms[j]);
      if (!e) continue;
      const a = find(ms[i].r.id), b = find(ms[j].r.id);
      if (a !== b) { parent.set(b, a); why.set(`${ms[i].r.id}|${ms[j].r.id}`, e); }
    }
  }
  const comps = new Map<string, Info[]>();
  for (const i of info) { const c = find(i.r.id); const a = comps.get(c); if (a) a.push(i); else comps.set(c, [i]); }
  const out: { child: string; parent: string; why: string }[] = [];
  for (const ms of comps.values()) {
    if (ms.length < 2) continue;
    // Parent = the stream charging most recently; ties go to more charges.
    const p = [...ms].sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "") || b.n - a.n)[0];
    for (const m of ms) {
      if (m.r.id === p.r.id) continue;
      setMerged(m.r.id, p.r.id, "auto");
      const w = [...why].find(([k]) => k.includes(m.r.id))?.[1] ?? "chain";
      out.push({ child: m.r.id, parent: p.r.id, why: w });
    }
  }
  return { merged: out };
}

// ── Deterministic labelling pass ────────────────────────────────────────────
// Every row gets a type and a taxonomy category where the rules can tell. Your
// edits (source 'user') are never touched. A legacy type (set before sources were
// tracked: could be yours) is kept unless a rule says transfer; an AI type yields
// only to a registry brand. Idempotent: a second run changes nothing.
export function labelSubscriptions(): { typed: number; categorized: number } {
  const d = ensureSubsSchema();
  const rows = d.prepare(
    `SELECT id, merchant, merchant_key, category, type, type_source, category_source FROM subscriptions WHERE direction = 'expense' AND state != 'dismissed'`
  ).all() as { id: string; merchant: string; merchant_key: string; category: string | null; type: string | null; type_source: string | null; category_source: string | null }[];
  const setType = d.prepare(`UPDATE subscriptions SET type = ?, type_source = ? WHERE id = ?`);
  const setCat = d.prepare(`UPDATE subscriptions SET category = ?, category_source = ? WHERE id = ?`);
  let typed = 0, categorized = 0;
  for (const r of rows) {
    const rule = ruleLabel(r.merchant, r.merchant_key, r.category);
    let type = r.type as SubType;
    const src = r.type_source ?? "rule";
    if (src !== "user") {
      let next = type;
      if (src === "rule") next = rule.type ?? type;
      else if (src === "ai") next = rule.brand ? rule.type : type;
      else if (src === "legacy") next = rule.type === "transfer" || !type ? rule.type ?? type : type;
      if (next !== type || (next && !r.type_source)) {
        setType.run(next, next === type && r.type_source ? r.type_source : "rule", r.id);
        if (next !== type) typed++;
        type = next;
      }
    }
    if (r.category_source !== "user") {
      let cat = r.category;
      if (rule.brand) cat = rule.brand.category;
      else if (!cat || !TAXO.has(cat) || (type === "transfer" && !cat.startsWith("Transfer"))) cat = type ? categoryForType(type, r.category) : rule.category ?? (cat && TAXO.has(cat) ? cat : "Other");
      if (cat !== r.category) { setCat.run(cat, "rule", r.id); categorized++; }
    }
  }
  return { typed, categorized };
}


// ── AI layer (local model via the gateway; same propose/refine discipline as
//    categorize.ts — read the web for cancel-guide only, never for classification) ─

const CLASSIFY_SYSTEM = `You label a person's recurring charges for a finance app. For each item return a type and a category.
type:
- "subscription": a recurring service they could cancel (streaming, software, news, apps, AI tools, cloud, SaaS, delivery pass).
- "membership": a club, warehouse, gym, association, card annual fee or loyalty membership.
- "bill": a payment they cannot simply cancel: mortgage, rent, loan, insurance, utility, phone, tax, medical, tuition, tolls.
- "transfer": money moved, not spent: to savings, investing, a 529, a person (Zelle, Venmo), a kid's card.
category: exactly one of ${CATEGORIES.join(", ")}.
Output ONLY a JSON array, one object per input: [{"id": "<the id>", "type": "<type>", "category": "<category>"}]. No prose, no markdown.`;

const TYPE_SET = new Set(["subscription", "membership", "bill", "transfer"]);

// LLM pass over the rows the rules could not label. Fills gaps only: the UPDATE
// requires type IS NULL and a non-user source, so a rule, an earlier AI answer
// or your own edit always wins. Mechanical lane (thinking off), one sequential
// call per batch (the gateway plan allows ~2 concurrent). Throws on a gateway
// error; postSyncEnrich wraps it.
export async function classifySubscriptionTypes(opts: { limit?: number; timeoutMs?: number; batch?: number } = {}): Promise<{ processed: number; updated: number }> {
  const d = ensureSubsSchema();
  const rows = d.prepare(
    `SELECT id, merchant, category, monthly, cadence FROM subscriptions
     WHERE direction = 'expense' AND state != 'dismissed' AND merged_into IS NULL AND type IS NULL
       AND COALESCE(type_source, '') != 'user'
     ORDER BY monthly DESC LIMIT ?`
  ).all(opts.limit ?? 200) as { id: string; merchant: string; category: string | null; monthly: number; cadence: string | null }[];
  if (!rows.length) return { processed: 0, updated: 0 };

  let updated = 0;
  const BATCH = opts.batch ?? 30;
  const setType = d.prepare(
    `UPDATE subscriptions SET type = ?, type_source = 'ai', updated_at = datetime('now')
     WHERE id = ? AND type IS NULL AND COALESCE(type_source, '') != 'user'`
  );
  const setCat = d.prepare(
    `UPDATE subscriptions SET category = ?, category_source = 'ai' WHERE id = ? AND COALESCE(category_source, '') NOT IN ('user', 'rule')`
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({ ...r, monthly: round2(r.monthly) }));
    const reply = await chat(
      [{ role: "system", content: CLASSIFY_SYSTEM }, { role: "user", content: JSON.stringify(batch) }],
      { maxTokens: 1400, reasoning: false, timeoutMs: opts.timeoutMs },
    );
    const parsed = extractJson<{ id: string; type: string; category?: string }[]>(reply);
    if (!Array.isArray(parsed)) continue;
    const ids = new Set(batch.map((b) => b.id));
    for (const p of parsed) {
      if (!p?.id || !ids.has(p.id) || !TYPE_SET.has(p.type)) continue;
      const n = Number(setType.run(p.type, p.id).changes ?? 0);
      updated += n;
      if (n && p.category && TAXO.has(p.category)) setCat.run(p.category, p.id);
    }
  }
  return { processed: rows.length, updated };
}


const OVERLAP_SYSTEM = `You find overlapping or redundant subscriptions for one person — services that do the same job, so they could consolidate and save. Examples: multiple video-streaming services, multiple music services, multiple cloud-storage services, multiple of the same vendor, two products that solve the same need.
Given a JSON array of subscriptions, return ONLY a JSON array of GROUPS. Each group: {"label": "<plain-English shared category, e.g. Video streaming>", "ids": [<member id strings>], "note": "<one short consolidation hint>"}. Only include a group with 2 or more members. If nothing overlaps, return []. No prose, no markdown.`;

export type OverlapGroup = {
  label: string; note: string; ids: string[]; monthly: number;
  members: { id: string; merchant: string; monthly: number }[];
};

// Overlap groups: the registry families first (deterministic, works with the
// model down), then one best-effort LLM pass for the semantic ones the registry
// does not know. Read-only; nothing is written.
export async function detectOverlaps(entity?: string | null): Promise<{ groups: OverlapGroup[] }> {
  const active = listSubscriptions(entity).subs.filter((s) => s.group === "subs" && live(s));
  if (active.length < 2) return { groups: [] };
  const byId = new Map(active.map((s) => [s.id, s]));
  const mk = (label: string, note: string, members: Subscription[]): OverlapGroup => ({
    label, note, ids: members.map((m) => m.id),
    members: members.map((m) => ({ id: m.id, merchant: m.displayName, monthly: m.monthly })),
    monthly: round2(members.reduce((a, m) => a + m.monthly, 0)),
  });
  const fams = new Map<string, Subscription[]>();
  for (const s of active) for (const o of s.overlapWith) {
    const a = fams.get(o.label) ?? []; if (!a.includes(s)) a.push(s); fams.set(o.label, a);
  }
  const groups: OverlapGroup[] = [...fams].map(([label, ms]) => mk(label, "Same job, two bills: keep the one you use most.", ms));
  const covered = new Set(groups.flatMap((g) => g.ids));
  try {
    const reply = await chat(
      [
        { role: "system", content: OVERLAP_SYSTEM },
        { role: "user", content: JSON.stringify(active.map((s) => ({ id: s.id, merchant: s.displayName, category: s.svcGroup ?? s.category, monthly: s.monthly }))) },
      ],
      { maxTokens: 1000, reasoning: false },
    );
    const parsed = extractJson<{ label?: string; ids?: string[]; note?: string }[]>(reply);
    for (const g of Array.isArray(parsed) ? parsed : []) {
      const members = (g.ids ?? []).map((id) => byId.get(id)).filter((m): m is Subscription => !!m);
      if (members.length < 2 || members.every((m) => covered.has(m.id))) continue;
      groups.push(mk(g.label ?? "Overlap", g.note ?? "", members));
    }
  } catch { /* model down: the registry groups stand */ }
  return { groups: groups.sort((a, b) => b.monthly - a.monthly) };
}


// ── Cut plan: the synthesized "what to cut" savings list ─────────────────────
// One pass that turns the scattered signals (unused, price hikes, redundant
// overlaps, trials about to convert) into a single ranked cancel list with a
// recoverable-$/yr total. Hybrid: the deterministic flags below already build a
// useful plan with zero AI (so it works when the GPU is busy); the best-effort
// local-model pass reorders and writes a human reason per item, degrading to the
// deterministic plan on any model failure. Read-only — the UI ties the result
// into the existing what-if meter (ticking a row drops the hero), nothing is
// written here.

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export type CutPlanItem = {
  id: string; merchant: string; monthly: number; annual: number;
  reason: string; kind: "unused" | "hike" | "overlap" | "trial" | "low-value";
  confidence: "high" | "medium" | "low";
};
export type CutPlan = {
  headline: string; items: CutPlanItem[];
  totalMonthly: number; totalAnnual: number; aiUsed: boolean;
};

const CUT_KINDS = new Set(["unused", "hike", "overlap", "trial", "low-value"]);
const CUT_CONF = new Set(["high", "medium", "low"]);

// The deterministic signal for one sub — the floor the AI builds on / falls back
// to. Returns null for a sub with no obvious reason to cut (a healthy keeper).
function cutSignal(s: Subscription): Pick<CutPlanItem, "reason" | "kind" | "confidence"> | null {
  if (s.state === "trial") return { reason: "Free trial — will start charging", kind: "trial", confidence: "high" };
  if (s.overlapWith.length) return { reason: `Overlaps ${s.overlapWith[0].merchant}`, kind: "overlap", confidence: "medium" };
  if (s.priceChange > 0.5) return { reason: `Price went up ${usd(s.priceChange)} a charge`, kind: "hike", confidence: "medium" };
  return null;
}

const CUT_SYSTEM = `You are a subscription savings advisor. From a person's active recurring subscriptions, pick the ones genuinely worth cancelling and rank them best-to-cut first. Weigh: unused (flagged inactive / no recent charge), recent price increases, redundant services that overlap another in the list (cancel the weaker one, keep the best of a pair), poor value for the cost, and free trials about to convert to paid. Do NOT pad the list — only include items a reasonable person would actually cancel, and leave strong keepers out.
Return ONLY JSON:
{"headline":"<one short line, e.g. Cancel 4 to recover $612/yr>","items":[{"id":<the id string>,"reason":"<under 8 words, concrete>","kind":"<unused|hike|overlap|trial|low-value>","confidence":"<high|medium|low>"}]}
No prose, no markdown.`;

export async function buildCutPlan(entity?: string | null): Promise<CutPlan> {
  // Ended rows cost nothing and bills/transfers are not cuttable: hero rows only.
  const active = listSubscriptions(entity).subs.filter((s) => s.group === "subs" && live(s));
  if (!active.length) return { headline: "Nothing to cut", items: [], totalMonthly: 0, totalAnnual: 0, aiUsed: false };
  const byId = new Map(active.map((s) => [s.id, s]));

  // Best-effort AI ranking pass over the whole active set (so it can spot
  // overlaps too); savings always come from OUR amounts, never the model's.
  let items: CutPlanItem[] = [];
  let aiUsed = false;
  try {
    const payload = active.map((s) => ({
      id: s.id, merchant: s.displayName, group: s.svcGroup ?? s.category, monthly: s.monthly,
      priceIncrease: round2(s.priceChange), trial: s.state === "trial",
      overlapsWith: s.overlapWith.map((o) => o.merchant),
    }));
    const reply = await chat(
      [{ role: "system", content: CUT_SYSTEM }, { role: "user", content: JSON.stringify(payload) }],
      { maxTokens: 900 },
    );
    const parsed = extractJson<{ headline?: string; items?: { id: string; reason?: string; kind?: string; confidence?: string }[] }>(reply);
    if (parsed && Array.isArray(parsed.items)) {
      const seen = new Set<string>();
      items = parsed.items
        .map((it): CutPlanItem | null => {
          const s = byId.get(it.id);
          if (!s || seen.has(it.id)) return null;
          seen.add(it.id);
          const det = cutSignal(s);
          return {
            id: s.id, merchant: s.displayName, monthly: s.monthly, annual: round2(s.monthly * 12),
            reason: (it.reason ?? "").trim().slice(0, 64) || det?.reason || "Recurring cost worth a look",
            kind: (CUT_KINDS.has(it.kind ?? "") ? it.kind : det?.kind ?? "low-value") as CutPlanItem["kind"],
            confidence: (CUT_CONF.has(it.confidence ?? "") ? it.confidence : det?.confidence ?? "medium") as CutPlanItem["confidence"],
          };
        })
        .filter((x): x is CutPlanItem => x !== null);
      if (items.length) { aiUsed = true; }
    }
  } catch { /* model down / unparseable — deterministic plan below */ }

  // Deterministic plan: every sub with a cut signal, ranked by annual savings.
  if (!items.length) {
    items = active
      .map((s): CutPlanItem | null => {
        const det = cutSignal(s);
        return det ? { id: s.id, merchant: s.displayName, monthly: s.monthly, annual: round2(s.monthly * 12), ...det } : null;
      })
      .filter((x): x is CutPlanItem => x !== null)
      .sort((a, b) => (b.confidence === a.confidence ? b.annual - a.annual : (b.confidence === "high" ? 1 : -1)));
  }

  items = items.slice(0, 8);
  // Headline is always templated from OUR totals — never the model's number
  // (the model fabricates dollar figures; per-item reasons are its only job).
  const totalMonthly = round2(items.reduce((a, i) => a + i.monthly, 0));
  const totalAnnual = round2(totalMonthly * 12);
  const headline = items.length
    ? `Cancel ${items.length} to recover ${usd(totalAnnual)}/yr`
    : "Nothing obvious to cut — nicely trimmed";
  return { headline, items, totalMonthly, totalAnnual, aiUsed };
}

// ── Manual add ──────────────────────────────────────────────────────────────

// Hand-add a subscription Plaid didn't detect (a new annual plan, a fresh signup).
// Keyed the same way detection keys, so if real charges show up later they merge
// into this row rather than duplicating it.
export function createManualSubscription(input: { entity?: string; merchant: string; amount: number; cadence: string; category?: string | null }): string | null {
  const merchant = input.merchant.trim();
  if (!merchant) return null;
  const key = norm(merchant);
  if (!key) return null;
  const entity = input.entity && input.entity !== "all" ? input.entity : "personal";
  const cadence = CADENCE_DAYS[input.cadence] ? input.cadence : "monthly";
  const intervalDays = CADENCE_DAYS[cadence];
  const amount = Math.abs(input.amount) || 0;
  const monthly = round2(amount * (30.44 / intervalDays));
  const category = input.category && input.category.trim() ? input.category.trim() : null;
  const id = `${entity}:expense:${key}`;
  db().prepare(
    `INSERT INTO subscriptions
       (id, entity, merchant_key, merchant, source, direction, type, category, cadence, interval_days,
        avg_amount, last_amount, monthly, count, last_date, next_expected, is_active, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', 'expense', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, 'active', datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
        merchant = excluded.merchant, avg_amount = excluded.avg_amount, last_amount = excluded.last_amount,
        monthly = excluded.monthly, cadence = excluded.cadence, interval_days = excluded.interval_days,
        category = COALESCE(subscriptions.category, excluded.category), state = 'active', updated_at = datetime('now')`
  ).run(
    id, entity, key, merchant, classifyType(category, merchant, monthly) ?? "subscription", category,
    cadence, intervalDays, amount, amount, monthly, today(), addDays(today(), intervalDays),
  );
  return id;
}

const EDITABLE = ["state", "type", "merchant", "category", "color", "icon", "note", "trial_ends", "entity", "work_move", "user_cadence"] as const;

// Patch user-owned fields. Parameterized; never touches detection columns. A
// cancelled/dismissed state set here survives the next reconcile (reconcile never
// rewrites state). Setting type or category marks it yours ('user'), so neither
// the rules nor the LLM pass touch it again.
export function updateSubscription(id: string, body: Record<string, unknown>): boolean {
  ensureSubsSchema();
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const f of EDITABLE) {
    if (f in body) {
      let v = body[f] === "" || body[f] == null ? null : String(body[f]);
      if (f === "type" && v === "obligation") v = "bill";
      if (f === "type" && v && !TYPE_SET.has(v)) continue;
      if (f === "user_cadence" && v && !CADENCE_DAYS[v]) continue;
      sets.push(`${f} = ?`);
      args.push(v);
      if (f === "type") sets.push(`type_source = ${v ? "'user'" : "NULL"}`);
      if (f === "category") sets.push(`category_source = ${v ? "'user'" : "NULL"}`);
    }
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  args.push(id);
  const res = db().prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
  return Number(res.changes ?? 0) > 0;
}
