import crypto from "node:crypto";
import { db } from "./db";
import { chat, extractJson } from "./llm";
import { CATEGORIES, mapPfc } from "./taxonomy";
import { ruleMatches, RULE_ORDER, MULTI_CATEGORY_MERCHANT, type RuleRow } from "./categorize";
import { receiptForTxn, matchReceipts, fetchGmailReceipts, importOrdersCsv, AMAZON_TXN as AMAZON_LIKE, type TxnReceipt } from "./orders";

export type DbRule = RuleRow & { source: string; id: number; priority?: number };

// One classifier for every non-manual transaction, used by the one-off full pass
// (scripts/recategorize-all.mts) and after each sync (classifyNewTransactions).
// Signals, strongest first:
//   hold list -> user rules -> order receipt -> descriptor rules -> single-category
//   LLM rules -> LLM -> mapPfc.
// A merchant that sells many kinds of things (Amazon, Walmart, Apple, Uber) is
// decided per transaction here, never by a blanket merchant rule.

export interface TxnRow {
  id: string; date: string; name: string | null; merchant: string | null; amount: number;
  plaid_category: string | null; plaid_detailed: string | null;
  category: string | null; category_source: string | null; confidence: number | null;
  account_type: string | null;
  // Plaid's merchant_name before any rename: the stable input for the model
  // (so a rename cannot change its answer) and the key new rules match on.
  raw_merchant?: string | null;
}

export interface Decision {
  category: string;
  merchant?: string;      // display merchant to write; omitted = keep
  confidence: number;
  source: "rule" | "llm";
  reason: string;         // which signal decided, for the dry-run report
}

const CATS = new Set<string>(CATEGORIES);

// The owner left these for review on purpose; nothing here touches them.
export const HOLD = /prosper marketpl|rr bowker|r\.r\. bowker/i;

// Below this the row is a guess: it is written, but To-Review shows it.
export const REVIEW_BELOW = 0.7;

// ---------------------------------------------------------------------------
// Receipt -> category. Amazon's own category labels ("Snack Foods", "Computer
// Accessories") and item names, matched by keyword. Order matters: Pets before
// Groceries ("cat treats"), Healthcare before Household ("health care"
// essentials). Returns null when nothing matches, so the LLM reads the items.

const RECEIPT_KEYWORDS: [string, RegExp][] = [
  ["Subscriptions", /^kindle book/i],
  ["Pets", /\bpets?\b|\bdog\b|\bcat (treats|litter|food)|churu|petco|chewy|\bpuppy|kitten|poop bag|slip lead/i],
  ["Healthcare", /health care|drugstore|supplement|vitamin|vision care|contact lens|reading glasses|nutrition|wellness|citracal|first aid|medicine/i],
  ["Personal Care", /hair care|personal care|beauty|skin care|shav|oral care|cosmetic|deodorant|lotion/i],
  ["Groceries", /cereal|snack|coffee|beverage|pantry|grocer|almond|\brice\b|protein bar|sparkling water|la ?croix|goldfish|love crunch|whole foods|\btea\b|soda|chocolate|candy|food(?! scoop)/i],
  ["Electronics", /electronic|computer|phone|wireless|device accessor|\busb\b|charger|cable|anker|tp-link|router|mesh wi-?fi|ethernet|switch|microphone|xlr|headphone|earbud|keyboard|mouse|monitor|ssd|hard drive|camera/i],
  ["Clothing", /clothing|apparel|shoe|sneaker|sock|shirt|pants|dress|jacket|womens golf glove|\bhat\b/i],
  ["Entertainment", /^books?$|\bbooks\b|golf|lego|\btoys?\b|game|puzzle|sports/i],
  ["Household", /household|essentials|bedding|lawn|garden|plumbing|\bpool\b|lighting|\btools?\b|hardware|electrical|heating|kitchen|appliance|paper|trash|hefty|napkin|windex|microfiber|raid|\bants?\b|roach|odor|shelf|door|tape measure|picture frame|nonstick|zojirushi|melitta|silicone|satin|gloves|child safety|batter(y|ies)|cr2032|\baa\b|lint|cleaning|detergent|towel|light base|storage|organizer/i],
  ["Shopping", /office|luggage|folders|stickers|party|birthday|mardi gras|crystal photo|gift/i],
];

export function receiptCategory(r: Pick<TxnReceipt, "labels" | "items" | "kind">): { category: string; mixed: boolean } | null {
  if (r.kind === "wholefoods") return { category: "Groceries", mixed: false };
  // Labels are Amazon's categories; split "Coffee, Pet Supplies" and
  // "Essentials and Snack Foods" into their parts. Item names fill in when the
  // email had no label.
  const parts = r.labels
    .flatMap((l) => l.startsWith("Kindle book") ? [l] : l.split(/,\s*|\s+and\s+(?:other)?/i))
    .map((s) => s.trim()).filter((s) => s && !/^other$/i.test(s));
  const tally = (texts: string[]) => {
    const v = new Map<string, number>();
    for (const t of texts) {
      const hit = RECEIPT_KEYWORDS.find(([, re]) => re.test(t));
      if (hit) v.set(hit[0], (v.get(hit[0]) ?? 0) + 1);
    }
    return v;
  };
  let votes = tally(parts);
  if (!votes.size) votes = tally(r.items.map((i) => i.name));
  if (!votes.size) return null;
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  return { category: ranked[0][0], mixed: ranked.length > 1 };
}

// ---------------------------------------------------------------------------
// Descriptor rules: the raw bank descriptor says more than the merchant name for
// merchants that sell many things, and a few owner-stated facts live here.
// Each returns a decision or null; first hit wins.

type DRule = (t: TxnRow, s: string) => Omit<Decision, "source" | "reason"> | null;
const D = (category: string, confidence: number, merchant?: string) => ({ category, confidence, merchant });

// Ally appends "~ Future Amount: 10649.53 ~ Tran: DDIR" to scheduled items.
export function stripAllySuffix(s: string): string {
  return s.replace(/~\s*Future Amount:.*$/i, "").replace(/\s+/g, " ").trim();
}

const isCleanerPayment = (t: TxnRow, s: string) =>
  /espericueta/.test(s) ||
  // The cleaner is $240 a visit; after the Zelle payments stopped she is paid
  // by Venmo. A Venmo outflow in whole visits (1-6) is her; any other amount is not.
  (/^venmo\b/.test(s) && t.amount > 0 && Math.round(t.amount * 100) % 24000 === 0 && t.amount <= 1440);

export const DESCRIPTOR_RULES: [string, DRule][] = [
  // --- owner facts
  ["house cleaner", (t, s) => isCleanerPayment(t, s) ? D("Home", 0.9, "Maria Espericueta (house cleaner)") : null],
  ["jpmorgan ext transfer", (t, s) => /jpmorgan chase ext trnsfr/.test(s) && t.amount > 0 ? D("Loan Payments", 0.85, "Chase monthly payment") : null],
  ["tatte", (_t, s) => /tatte/.test(s) ? D("Dining", 1, undefined) : null],
  ["airbnb", (t, s) => /airbnb/.test(s) && t.amount > 0 ? D("Travel", 1) : null],

  // --- Amazon family
  ["amazon tips", (_t, s) => /amazon tips/.test(s) ? D("Groceries", 0.95, "Amazon (delivery tip)") : null],
  ["amazon grocery subscription", (_t, s) => /amazon grocery subscri/.test(s) ? D("Subscriptions", 0.95, "Amazon Grocery Subscription") : null],
  ["kindle unlimited", (_t, s) => /kindle unltd/.test(s) ? D("Subscriptions", 1, "Kindle Unlimited") : null],
  ["kindle", (_t, s) => /kindle svcs|kindle\b/.test(s) ? D("Subscriptions", 0.95, "Amazon Kindle") : null],
  ["prime video", (_t, s) => /prime ?video|primevideo/.test(s) ? D("Subscriptions", 1, "Prime Video") : null],
  ["amazon prime", (_t, s) => /^amazon prime\b|amzn prime|prime membership/.test(s) ? D("Subscriptions", 1, "Amazon Prime") : null],
  ["amazon fresh", (_t, s) => /amazon fresh|amzn fresh/.test(s) ? D("Groceries", 0.95, "Amazon Fresh") : null],
  ["kdp royalties", (t, s) => t.amount < 0 && /amazon media eu|amazon\.com servi(ces)?(\s+llc)?\s+payment/.test(s)
    ? D("Income", 0.95, "Amazon KDP royalties") : null],
  ["amazon ads", (_t, s) => /amazon media group/.test(s) ? D("Other", 0.9, "Amazon Ads") : null],
  ["amazon purchase", (_t, s) => /amzn|amazon(\.com|\s+mktpl|\s+mktp|\s+marketplace)/.test(s) ? D("Shopping", 0.6, "Amazon") : null],

  // --- Apple, Google
  ["apple cash", (_t, s) => /apple cash sent|apple cash/.test(s) ? D("Transfer:P2P", 0.9, "Apple Cash") : null],
  // Apple Developer Program is a $99/yr APPLE.COM/US charge (receipt 2026-06-17).
  ["apple developer", (t, s) => /apple\.com\/us/.test(s) && t.amount === 99 ? D("Subscriptions", 0.9, "Apple Developer Program") : null],
  ["apple store", (_t, s) => /apple\.com\/us|apple store|apple online/.test(s) ? D("Electronics", 0.75, "Apple Store") : null],
  ["apple services", (_t, s) => /apple\.com\/bill|itunes/.test(s) ? D("Subscriptions", 0.95, "Apple") : null],
  ["google one", (_t, s) => /google one/.test(s) ? D("Subscriptions", 1, "Google One") : null],
  ["google workspace", (_t, s) => /google.*work|workspace/.test(s) ? D("Subscriptions", 1, "Google Workspace") : null],
  ["google play", (_t, s) => /google play|^g1sk/.test(s) ? D("Entertainment", 0.8, "Google Play") : null],

  // --- big-box and convenience
  ["walmart+", (t, s) => /walmart\+|walmart plus/.test(s) || (/walmart/.test(s) && Math.abs(t.amount) === 12.95)
    ? D("Subscriptions", 0.95, "Walmart+") : null],
  ["walmart", (_t, s) => /walmart|wal-mart|wm supercenter/.test(s) ? D("Groceries", 0.65) : null],
  ["target", (_t, s) => /^target\b/.test(s) ? D("Shopping", 0.6) : null],
  ["costco gas", (t, s) => /costco/.test(s) && (/gas/.test(s) || t.plaid_detailed === "TRANSPORTATION_GAS") ? D("Transportation", 0.95, "Costco Gas") : null],
  ["costco", (_t, s) => /costco/.test(s) ? D("Groceries", 0.8) : null],
  ["fuel stop", (t, s) => /wawa|sheetz|royal farms|7-eleven|circle k/.test(s)
    ? (t.plaid_detailed === "TRANSPORTATION_GAS" || /fuel/.test(s) ? D("Transportation", 0.85) : D("Dining", 0.65)) : null],

  // --- Uber
  ["uber one", (_t, s) => /uber\s*\*?\s*one/.test(s) ? D("Subscriptions", 1, "Uber One") : null],
  ["uber eats", (_t, s) => /uber ?eats/.test(s) ? D("Dining", 1, "Uber Eats") : null],
  ["uber trip", (_t, s) => /^uber\b/.test(s) ? D("Transportation", 0.95, "Uber") : null],

  // --- loans and money movement
  ["auto loan", (t, s) => /hyundai motor finance|hmf hmfusa|motor finance/.test(s) && t.amount > 0 ? D("Loan Payments", 0.95, "Hyundai Motor Finance") : null],
  ["student loan", (t, s) => /dept education student ln|department of education/.test(s) && t.amount > 0 ? D("Loan Payments", 0.95, "US Dept of Education (student loan)") : null],
  // Plaid files the USAA property & casualty autopay as a card payment; it is the insurance premium.
  ["usaa p&c", (t, s) => /usaa p&c|usaa p ?c autopay/.test(s) && t.amount > 0 ? D("Insurance", 0.95, "USAA Insurance") : null],
  ["529", (_t, s) => /invest ?529/.test(s) ? D("Transfer:Brokerage", 1, "Invest529") : null],
  ["spouse zelle", (_t, s) => /zelle.*(sarah schroeder)/.test(s) ? D("Transfer:Internal", 0.85) : null],

  // --- pets
  ["vet", (t, s) => /animal medical|veterinar|\bvet\b|banfield/.test(s) || t.plaid_detailed === "MEDICAL_VETERINARY_SERVICES" ? D("Pets", 0.9) : null],
  ["pet store", (_t, s) => /chewy|petco|petsmart|kuranda/.test(s) ? D("Pets", 0.95) : null],

  // --- card statement credits offset what they reimburse
  ["resy credit", (t, s) => t.amount < 0 && /resy credit/.test(s) ? D("Dining", 0.9) : null],
  ["clear credit", (t, s) => t.amount < 0 && /clear plus credit/.test(s) ? D("Travel", 0.9) : null],
  ["lululemon credit", (t, s) => t.amount < 0 && /lululemon credit/.test(s) ? D("Clothing", 0.9) : null],
];

export function descriptorDecision(t: TxnRow): Decision | null {
  const s = `${stripAllySuffix(t.name ?? "")} ${(t.raw_merchant !== undefined ? t.raw_merchant : t.merchant) ?? ""}`.toLowerCase().trim();
  for (const [reason, rule] of DESCRIPTOR_RULES) {
    const hit = rule(t, s);
    if (hit) return { ...hit, source: "rule", reason: `descriptor:${reason}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rules from the db. User rules (source != 'llm') are the owner's intent and
// beat everything but the hold list. LLM rules only count when the audit kept
// them (single-category merchants), and never on a multi-category merchant.

export function loadRules(): DbRule[] {
  return db().prepare(`SELECT match_type, pattern, field, category, entity, rename, source, id, priority FROM rules ORDER BY ${RULE_ORDER}`)
    .all() as unknown as DbRule[];
}

function ruleDecision(t: TxnRow, rules: DbRule[], which: "user" | "llm"): Decision | null {
  let category: string | undefined, merchant: string | undefined, id: number | undefined;
  for (const r of rules) {
    if ((r.source === "llm") !== (which === "llm")) continue;
    if (!ruleMatches(r, t.merchant, t.name ?? "")) continue;
    if (which === "llm" && MULTI_CATEGORY_MERCHANT.test(`${t.merchant ?? ""} ${t.name ?? ""}`)) continue;
    if (category === undefined && r.category && CATS.has(r.category)) { category = r.category; id = r.id; }
    if (merchant === undefined && r.rename) merchant = r.rename;
  }
  if (!category) return null;
  return { category, merchant, confidence: 1, source: "rule", reason: `${which}-rule#${id}` };
}

// ---------------------------------------------------------------------------
// LLM (fast lane). Answers are cached by a hash of what the model saw, so a
// second run is free and returns the same thing (the pass is idempotent).

const LLM_SYSTEM = `You categorize one person's bank and card transactions.
Return ONLY a JSON array, one object per input: {"id": <id>, "category": <one allowed category>, "merchant": <short clean display name, or null to keep>, "confidence": <0..1>}.
Allowed categories: ${CATEGORIES.join(", ")}.
Meanings: Groceries = supermarkets, food to cook at home. Dining = restaurants, cafes, bars, takeout, food stalls while travelling.
Shopping = general merchandise only when nothing more specific fits. Electronics = devices, computer/phone accessories, cables.
Household = cleaning, paper goods, kitchenware, tools, garden, small appliances. Home = HOA dues, home repair, contractors, cleaners, plumbers, HVAC, electricians.
Clothing = apparel, shoes. Pets = pet food, supplies, vet. Personal Care = hair, nails, spa, beauty, dry cleaning.
Subscriptions = recurring software, apps, streaming, memberships, cloud and AI services. Entertainment = events, museums, golf, games, one-off media.
Travel = hotels, flights, rental cars, tours, travel agencies, museum and ferry tickets abroad. Transportation = fuel, parking, tolls, transit, rideshare, car service.
Loan Payments = car, student or personal loan payments. Transfer:* and CreditCardPayment = moving own money, never spending.
Foreign-language merchant names are usually small shops, tavernas or kiosks visited while travelling: decide from the words.
If "receipt" is given, it lists what was bought: it decides the category.
"merchant": give a clean name only when the input merchant is null or is raw bank text; otherwise null.
Use confidence below 0.6 when you are guessing. No prose, no markdown.`;

interface LlmIn { id: string; name: string | null; merchant: string | null; plaid: string | null; amount: number; account: string | null; receipt?: string }
interface LlmOut { id: string; category: string; merchant?: string | null; confidence?: number }

export function ensureLlmCache(): void {
  db().exec(`CREATE TABLE IF NOT EXISTS category_llm_cache (
    key TEXT PRIMARY KEY, category TEXT NOT NULL, merchant TEXT, confidence REAL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}
const cacheKey = (x: LlmIn) => crypto.createHash("sha1").update(JSON.stringify({ ...x, v: 2 })).digest("hex");

export async function llmDecide(rows: LlmIn[], opts: { maxCalls?: number; batch?: number } = {}): Promise<Map<string, Decision>> {
  ensureLlmCache();
  const d = db();
  const out = new Map<string, Decision>();
  const get = d.prepare(`SELECT category, merchant, confidence FROM category_llm_cache WHERE key=?`);
  const put = d.prepare(`INSERT OR REPLACE INTO category_llm_cache (key, category, merchant, confidence) VALUES (?, ?, ?, ?)`);
  const todo: LlmIn[] = [];
  const keyOf = new Map<string, string>();
  for (const r of rows) {
    const k = cacheKey(r);
    keyOf.set(r.id, k);
    const c = get.get(k) as { category: string; merchant: string | null; confidence: number | null } | undefined;
    if (c) out.set(r.id, toDecision(c.category, c.merchant, c.confidence, "llm-cached"));
    else todo.push(r);
  }
  const batch = opts.batch ?? 20;
  let calls = 0;
  for (let i = 0; i < todo.length; i += batch) {
    if (opts.maxCalls !== undefined && calls >= opts.maxCalls) break;
    const chunk = todo.slice(i, i + batch);
    calls++;
    let parsed: LlmOut[] | null = null;
    try {
      const reply = await chat(
        [{ role: "system", content: LLM_SYSTEM }, { role: "user", content: JSON.stringify(chunk) }],
        { maxTokens: 2400, reasoning: false },
      );
      parsed = extractJson<LlmOut[]>(reply);
    } catch {
      parsed = null; // cold or busy model: these rows keep their category until next time
    }
    if (!Array.isArray(parsed)) continue;
    const sent = new Set(chunk.map((c) => c.id));
    for (const p of parsed) {
      if (!p?.id || !sent.has(p.id) || !CATS.has(p.category)) continue;
      const conf = typeof p.confidence === "number" && p.confidence >= 0 && p.confidence <= 1 ? p.confidence : 0.5;
      const m = typeof p.merchant === "string" && p.merchant.trim() && p.merchant.length <= 40 ? p.merchant.trim() : null;
      put.run(keyOf.get(p.id)!, p.category, m, conf);
      out.set(p.id, toDecision(p.category, m, conf, "llm"));
    }
  }
  return out;
}

function toDecision(category: string, merchant: string | null, confidence: number | null, reason: string): Decision {
  const conf = confidence ?? 0.5;
  // A guess is not written as a category: it parks in "Other" for To-Review.
  return { category: conf < 0.6 ? "Other" : category, merchant: merchant ?? undefined, confidence: conf, source: "llm", reason };
}

// ---------------------------------------------------------------------------
// The pipeline. `final` is what gets written; `independent` is the same answer
// with user rules ignored, which is what a manual pick is checked against.

export interface RowPlan { row: TxnRow; final: Decision | null; independent: Decision | null; receipt: TxnReceipt | null }

const TXN_SELECT = `SELECT t.id, t.date, t.name, t.merchant, t.amount, t.plaid_category, t.plaid_detailed,
  t.category, t.category_source, t.confidence, a.type AS account_type,
  CASE WHEN t.raw IS NULL THEN t.merchant ELSE json_extract(t.raw, '$.merchant_name') END AS raw_merchant
  FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id`;

export function loadTxns(where = "1=1", ...args: (string | number)[]): TxnRow[] {
  return db().prepare(`${TXN_SELECT} WHERE ${where} ORDER BY t.date, t.id`).all(...args) as unknown as TxnRow[];
}

function receiptText(r: TxnReceipt): string {
  const items = r.items.slice(0, 8).map((i) => i.name).join("; ");
  return [r.labels.join(" | "), items].filter(Boolean).join(" -- ").slice(0, 400);
}

export async function planRows(rows: TxnRow[], opts: { llm: boolean; rules?: DbRule[]; maxLlmCalls?: number }): Promise<RowPlan[]> {
  const rules = opts.rules ?? loadRules();
  const plans: RowPlan[] = [];
  const needLlm: { plan: RowPlan; input: LlmIn; slot: "both" | "independent" }[] = [];

  for (const t of rows) {
    const plan: RowPlan = { row: t, final: null, independent: null, receipt: null };
    plans.push(plan);
    if (HOLD.test(`${t.name ?? ""} ${t.merchant ?? ""}`)) continue;

    const user = ruleDecision(t, rules, "user");
    const receipt = AMAZON_LIKE.test(`${t.name ?? ""} ${t.merchant ?? ""}`) ? receiptForTxn(t.id) : null;
    plan.receipt = receipt;
    let indep: Decision | null = null;
    if (receipt) {
      const rc = receiptCategory(receipt);
      const merchant = receipt.kind === "wholefoods" ? "Whole Foods Market" : receipt.kind === "digital" ? "Amazon Kindle" : "Amazon";
      if (rc) indep = { category: rc.category, merchant, confidence: rc.mixed ? 0.8 : 0.95, source: "rule", reason: `receipt:${receipt.labels[0] ?? receipt.items[0]?.name ?? ""}`.slice(0, 80) };
    }
    if (!indep) {
      const desc = descriptorDecision(t);
      // A receipt the keywords could not place goes to the model with its items.
      if (desc && !(receipt && opts.llm)) indep = desc;
    }
    if (!indep) indep = ruleDecision(t, rules, "llm");
    if (!indep) {
      if (opts.llm) {
        needLlm.push({
          plan, slot: user ? "independent" : "both",
          input: { id: t.id, name: t.name ? stripAllySuffix(t.name) : null, merchant: t.raw_merchant ?? null, plaid: t.plaid_detailed,
            amount: t.amount, account: t.account_type, ...(receipt ? { receipt: receiptText(receipt) } : {}) },
        });
      } else {
        const m = mapPfc(t.plaid_category, t.plaid_detailed);
        // No model: only a raw Plaid label is worth moving, and only onto a decisive map.
        if (m && m !== "Other" && m !== t.category && (t.category_source === "plaid" || !CATS.has(t.category ?? ""))) {
          indep = { category: m, confidence: 0.5, source: "llm", reason: "pfc" };
        }
      }
    }
    plan.independent = indep;
    plan.final = user ?? indep;
  }

  if (needLlm.length) {
    const got = await llmDecide(needLlm.map((n) => n.input), { maxCalls: opts.maxLlmCalls });
    for (const n of needLlm) {
      let dec = got.get(n.input.id) ?? null;
      // An unsure model is no reason to throw away a real category: the row
      // keeps it (still low-confidence, so still in To-Review).
      const cur = n.plan.row.category;
      if (dec && dec.confidence < 0.6 && cur && CATS.has(cur) && cur !== "Other") dec = null;
      n.plan.independent = dec;
      if (n.slot === "both") n.plan.final = dec;
    }
  }
  return plans;
}

// What a write would change. Manual rows are never in it.
export interface Change { id: string; before: { category: string | null; source: string | null; merchant: string | null }; after: Decision }

export function diffPlans(plans: RowPlan[]): Change[] {
  const out: Change[] = [];
  for (const p of plans) {
    const t = p.row, f = p.final;
    if (!f || t.category_source === "manual") continue;
    const merchant = mergeMerchant(t, f);
    if (t.category === f.category && t.category_source === f.source && (t.confidence ?? null) === f.confidence && merchant === t.merchant) continue;
    out.push({ id: t.id, before: { category: t.category, source: t.category_source, merchant: t.merchant }, after: { ...f, merchant: merchant ?? undefined } });
  }
  return out;
}

// Rule and receipt names always apply; a model-suggested name only fills a blank.
function mergeMerchant(t: TxnRow, f: Decision): string | null {
  if (!f.merchant) return t.merchant;
  if (f.source === "llm") {
    if (t.merchant && t.merchant.trim()) return t.merchant;
    // The model tidies, it does not invent: every word it offers must already
    // be in the descriptor ("Computershare Dividends" for a share sale fails).
    const raw = (t.name ?? "").toLowerCase();
    const words = f.merchant.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    return words.length && words.every((w) => raw.includes(w)) ? f.merchant : t.merchant;
  }
  return f.merchant;
}

export function writeChanges(changes: Change[]): number {
  const d = db();
  const upd = d.prepare(
    `UPDATE transactions SET category=?, category_source=?, confidence=?, merchant=?
     WHERE id=? AND COALESCE(category_source,'') != 'manual'`,
  );
  let n = 0;
  d.exec("BEGIN");
  try {
    for (const c of changes) n += Number(upd.run(c.after.category, c.after.source, c.after.confidence, c.after.merchant ?? c.before.merchant, c.id).changes ?? 0);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return n;
}

// Manual picks the evidence disagrees with: a receipt, a descriptor rule, or a
// confident model answer says something else. For the owner to decide; never written.
export interface ManualFlag { id: string; date: string; name: string | null; amount: number; manual: string; suggested: string; why: string; confidence: number }
export function flagManualPicks(plans: RowPlan[]): ManualFlag[] {
  return plans
    .filter((p) => p.row.category_source === "manual" && p.independent && p.independent.category !== p.row.category
      && p.independent.confidence >= 0.8 && p.independent.category !== "Other")
    .map((p) => ({ id: p.row.id, date: p.row.date, name: p.row.merchant ?? p.row.name, amount: p.row.amount,
      manual: p.row.category ?? "", suggested: p.independent!.category, why: p.independent!.reason, confidence: p.independent!.confidence }));
}

// ---------------------------------------------------------------------------
// Rules audit. LLM rules are a cache of old model answers, so they go when the
// data contradicts them; user rules are never deleted, only flagged. New rules
// are written only for merchants that are one category every time.

export interface RuleAudit {
  deletes: { rule: DbRule; why: string }[];
  adds: { pattern: string; category: string; rows: number }[];
  manualFlags: { rule: DbRule; why: string }[];
}

export function auditRules(rules: DbRule[], plans: RowPlan[]): RuleAudit {
  const live = plans.filter((p) => !HOLD.test(`${p.row.name ?? ""} ${p.row.merchant ?? ""}`));
  // What each row really is: the owner's pick, else a confident decision.
  const truth = (p: RowPlan): string | null =>
    p.row.category_source === "manual" ? p.row.category
      : p.final && p.final.confidence >= 0.8 && p.final.category !== "Other" ? p.final.category : null;
  const matchedBy = (r: Pick<DbRule, "match_type" | "pattern" | "field">) =>
    live.filter((p) => ruleMatches(r, p.row.merchant, p.row.name ?? "")
      || ruleMatches(r, p.row.raw_merchant ?? null, p.row.name ?? ""));

  const deletes: RuleAudit["deletes"] = [];
  const seen = new Map<string, DbRule>();
  const user = rules.filter((r) => r.source !== "llm");
  for (const r of rules.filter((x) => x.source === "llm")) {
    const key = `${r.field}:${r.pattern.toLowerCase()}`;
    const dupUser = user.find((u) => `${u.field}:${u.pattern.toLowerCase()}` === key);
    if (seen.has(key)) { deletes.push({ rule: r, why: `duplicate of LLM rule #${seen.get(key)!.id}` }); continue; }
    seen.set(key, r);
    if (dupUser) { deletes.push({ rule: r, why: `duplicates user rule #${dupUser.id} (${dupUser.category ?? "rename"})` }); continue; }
    if (MULTI_CATEGORY_MERCHANT.test(r.pattern)) { deletes.push({ rule: r, why: "multi-category merchant: decided per transaction" }); continue; }
    if (r.pattern.trim().length < 4) { deletes.push({ rule: r, why: "pattern under 4 characters matches unrelated merchants" }); continue; }
    if (!r.category || !CATS.has(r.category)) { deletes.push({ rule: r, why: `category ${r.category} not in the taxonomy` }); continue; }
    const hits = matchedBy(r);
    const against = hits.filter((p) => { const t = truth(p); return t && t !== r.category; });
    if (against.length) {
      const what = [...new Set(against.map(truth))].join(", ");
      deletes.push({ rule: r, why: `contradicted by ${against.length} of ${hits.length} rows (${what})` });
    }
  }

  const deleted = new Set(deletes.map((x) => x.rule.id));
  const kept = rules.filter((r) => !deleted.has(r.id));
  const adds: RuleAudit["adds"] = [];
  const groups = new Map<string, RowPlan[]>();
  for (const p of live) {
    // Keyed on Plaid's own merchant_name, which is what sync matches a new row
    // on. Rows a descriptor rule or a receipt decides need no rule.
    if (p.final && /^(descriptor|receipt|user-rule)/.test(p.final.reason)) continue;
    const m = (p.row.raw_merchant ?? "").trim();
    if (!m || m.length < 4 || MULTI_CATEGORY_MERCHANT.test(m) || /zelle|transfer|payment|deposit|interest/i.test(m)) continue;
    groups.set(m, [...(groups.get(m) ?? []), p]);
  }
  for (const [m, ps] of groups) {
    if (ps.length < 3) continue;
    const ts = ps.map(truth);
    if (ts.some((t) => !t) || new Set(ts).size !== 1) continue;
    const category = ts[0]!;
    const rule = { match_type: "contains", pattern: m, field: "merchant" };
    const hits = matchedBy(rule);
    if (hits.some((p) => truth(p) !== category)) continue; // the substring would catch something else
    const covered = hits.every((p) => kept.some((r) => r.category === category && ruleMatches(r, p.row.merchant, p.row.name ?? "")));
    if (covered) continue;
    adds.push({ pattern: m, category, rows: ps.length });
  }

  const manualFlags: RuleAudit["manualFlags"] = [];
  for (const r of user) {
    if (!r.category) continue;
    const hits = matchedBy(r);
    const against = hits.filter((p) => p.independent && p.independent.confidence >= 0.85
      && p.independent.category !== "Other" && p.independent.category !== r.category);
    if (against.length && against.length * 2 >= hits.length) {
      manualFlags.push({ rule: r, why: `${against.length} of ${hits.length} rows look like ${[...new Set(against.map((p) => p.independent!.category))].join(", ")}` });
    }
  }
  return { deletes, adds, manualFlags };
}

export function applyRuleAudit(a: RuleAudit): { deleted: number; added: number } {
  const d = db();
  let deleted = 0, added = 0;
  d.exec("BEGIN");
  try {
    const del = d.prepare(`DELETE FROM rules WHERE id=? AND source='llm'`);
    for (const x of a.deletes) deleted += Number(del.run(x.rule.id).changes ?? 0);
    const ins = d.prepare(
      `INSERT INTO rules (match_type, pattern, field, category, source, priority)
       SELECT 'contains', ?, 'merchant', ?, 'llm', 50
       WHERE NOT EXISTS (SELECT 1 FROM rules WHERE lower(pattern)=lower(?) AND field='merchant')`,
    );
    for (const x of a.adds) added += Number(ins.run(x.pattern, x.category, x.pattern).changes ?? 0);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return { deleted, added };
}

// ---------------------------------------------------------------------------
// After each sync: rows the rules did not settle (still on Plaid's category),
// plus recent low-confidence rows that a receipt may have arrived for since.
// Capped, never throws, never touches manual rows.

export async function classifyNewTransactions(opts: { llm: boolean; maxRows?: number; fetchReceipts?: boolean }): Promise<{
  considered: number; changed: number; receipts?: unknown; error?: string;
}> {
  try {
    let receipts: unknown;
    if (opts.fetchReceipts !== false) {
      try {
        const g = process.env.ORDERS_GMAIL_ACCOUNT ? await fetchGmailReceipts({ sinceDays: 45, maxFetch: 80 }) : null;
        const c = importOrdersCsv();
        receipts = { gmail: g, csv: c, match: matchReceipts() };
      } catch (e) {
        receipts = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const rows = loadTxns(
      `COALESCE(t.category_source,'') != 'manual' AND (t.category_source = 'plaid' OR t.category IS NULL
        OR (t.category_source = 'rule' AND COALESCE(t.confidence, 1) < ? AND t.date >= date('now', '-45 days')))`,
      REVIEW_BELOW,
    ).slice(-(opts.maxRows ?? 200));
    const plans = await planRows(rows, { llm: opts.llm, maxLlmCalls: 5 });
    const changes = diffPlans(plans);
    return { considered: rows.length, changed: writeChanges(changes), receipts };
  } catch (e) {
    return { considered: 0, changed: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
