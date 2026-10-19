import { db } from "./db";
import { chat, extractJson } from "./llm";
import { CATEGORIES } from "./taxonomy";

export interface RuleHit {
  category?: string;
  entity?: string;
  rename?: string;
}

// Undo token for a manual-pick propagation: enough state to put the rule and
// every backfilled sibling row back exactly where they were.
export interface PropagationUndo {
  merchant: string;
  category: string;
  rule: {
    id: number;
    created: boolean;          // true = we inserted it (undo deletes it)
    prevCategory: string | null;
    prevSource: string | null;
    prevPriority: number | null;
  };
  affected: { id: string; prevCategory: string | null; prevSource: string | null; prevConfidence?: number | null }[];
}

// When a category is set by hand, remember the merchant so future syncs match it
// deterministically (a manual rule, priority 10 so the hand-pick beats any older
// LLM rule), and fill in the blanks on sibling transactions that the user hasn't
// hand-set. Mirrors applyRules() matching so the backfill == what the next sync
// would do. Returns an undo token (null if the merchant is too short to match
// safely). The clicked row itself is left to the caller's own UPDATE.
export function rememberMerchantCategory(txnId: string, category: string): PropagationUndo | null {
  if (!CATEGORIES.includes(category as never)) return null;
  const d = db();
  const row = d.prepare(`SELECT merchant, name FROM transactions WHERE id=?`).get(txnId) as
    | { merchant: string | null; name: string | null }
    | undefined;
  if (!row) return null;

  // One Amazon row's pick says nothing about the next Amazon order: no rule,
  // no backfill. The caller still sets the clicked row.
  if (MULTI_CATEGORY_MERCHANT.test(`${row.merchant ?? ""} ${row.name ?? ""}`)) return null;

  const merchant = (row.merchant ?? "").trim();
  const useMerchant = merchant.length >= 3;
  const field = useMerchant ? "merchant" : "name";
  const pattern = useMerchant ? merchant : (row.name ?? "").trim();
  if (pattern.length < 3) return null; // too generic to match without false hits

  // --- Upsert the rule -------------------------------------------------------
  const existing = d.prepare(
    `SELECT id, category, source, priority FROM rules WHERE lower(pattern)=lower(?) AND field=?`
  ).get(pattern, field) as
    | { id: number; category: string | null; source: string; priority: number }
    | undefined;

  let rule: PropagationUndo["rule"];
  if (existing) {
    d.prepare(`UPDATE rules SET category=?, source='manual', priority=10 WHERE id=?`).run(category, existing.id);
    rule = {
      id: existing.id, created: false,
      prevCategory: existing.category, prevSource: existing.source, prevPriority: existing.priority,
    };
  } else {
    const info = d.prepare(
      `INSERT INTO rules (match_type, pattern, field, category, source, priority)
       VALUES ('contains', ?, ?, ?, 'manual', 10)`
    ).run(pattern, field, category);
    rule = { id: Number(info.lastInsertRowid), created: true, prevCategory: null, prevSource: null, prevPriority: null };
  }

  // --- Backfill non-manual siblings (don't clobber deliberate hand-sets) ------
  // instr, not LIKE: a merchant holding % or _ must match literally.
  const haystack = field === "name" ? "lower(name)" : "lower(COALESCE(NULLIF(merchant,''), name))";
  const siblings = d.prepare(
    `SELECT id, category, category_source, confidence FROM transactions
     WHERE instr(${haystack}, ?) > 0 AND id != ? AND COALESCE(category_source,'') != 'manual'
       AND COALESCE(category,'') != ?`
  ).all(pattern.toLowerCase(), txnId, category) as { id: string; category: string | null; category_source: string | null; confidence: number | null }[];

  const setCat = d.prepare(
    `UPDATE transactions SET category=?, category_source='rule', confidence=1.0 WHERE id=?`
  );
  const affected = siblings.map((s) => {
    setCat.run(category, s.id);
    return { id: s.id, prevCategory: s.category, prevSource: s.category_source, prevConfidence: s.confidence };
  });

  return { merchant: pattern, category, rule, affected };
}

// Revert a propagation: restore the rule (delete if we created it, else restore
// its previous category/source/priority) and put every backfilled row back.
export function undoRememberMerchant(undo: PropagationUndo): void {
  const d = db();
  if (undo.rule.created) {
    d.prepare(`DELETE FROM rules WHERE id=?`).run(undo.rule.id);
  } else {
    d.prepare(`UPDATE rules SET category=?, source=?, priority=? WHERE id=?`).run(
      undo.rule.prevCategory, undo.rule.prevSource ?? "manual", undo.rule.prevPriority ?? 100, undo.rule.id,
    );
  }
  // The backfill set confidence=1.0; restoring it matters because To-Review
  // keys off confidence < 0.9. Tokens without prevConfidence leave it alone.
  const restore = d.prepare(
    `UPDATE transactions SET category=?, category_source=?, confidence=CASE WHEN ? THEN ? ELSE confidence END WHERE id=?`
  );
  for (const a of undo.affected) {
    const has = a.prevConfidence !== undefined;
    restore.run(a.prevCategory, a.prevSource, has ? 1 : 0, has ? a.prevConfidence ?? null : null, a.id);
  }
}

// The To-Review predicate, shared by the inbox and the badge so the two counts
// agree. "Other" is matched case-insensitively: raw Plaid OTHER rows are the
// same catch-all. Columns are unqualified, so alias-free FROM transactions only.
export const REVIEW_CATCHALL = `(category IS NULL OR upper(category) = 'OTHER')`;
export const REVIEW_WHERE = `reviewed = 0 AND (
  ${REVIEW_CATCHALL}
  -- "large" only matters for AI/Plaid guesses; a rule/manual recurring bill
  -- (mortgage, payroll) is already blessed and shouldn't loiter in review.
  OR (category_source IN ('plaid','llm') AND (COALESCE(confidence,0) < 0.9 OR ABS(amount) >= 1000))
  -- a code rule that could only guess (an Amazon charge with no receipt)
  OR (category_source = 'rule' AND COALESCE(confidence,1) < 0.7))`;

// Merchants that sell many kinds of things. Their category is decided per
// transaction (lib/recategorize.ts), never by a merchant-wide rule.
export const MULTI_CATEGORY_MERCHANT =
  /\b(amazon|amzn|walmart|target|costco|apple\.com|apple\b|google|uber|wawa|sheetz|venmo|zelle|paypal|cvs|walgreens|best buy|home depot|lowe'?s|etsy|ebay)\b/i;

// --- Rule layer (deterministic, user-editable, runs on every sync) ---
export interface RuleRow {
  match_type: string;
  pattern: string;
  field: string;
  category: string | null;
  entity: string | null;
  rename: string | null;
}

// Precedence: any user rule (source != 'llm') beats any LLM-written rule, then
// lower priority, then older id. A Rules-panel rule defaults to priority 100 and
// LLM rules to 50, so priority alone let the model override the user.
export const RULE_ORDER = `CASE WHEN source='llm' THEN 1 ELSE 0 END, priority ASC, id ASC`;

// The one matcher: sync (applyRules) and the Rules panel's "apply now" both use
// it, so a rule does the same thing in both places.
export function ruleMatches(r: Pick<RuleRow, "match_type" | "pattern" | "field">, merchant: string | null, name: string): boolean {
  const merchantText = (merchant ?? "").toLowerCase();
  const nameText = name.toLowerCase();
  const haystack = r.field === "name" ? nameText : merchantText || nameText;
  const needle = r.pattern.toLowerCase();
  if (r.match_type === "exact") return haystack === needle;
  if (r.match_type === "regex") {
    try { return new RegExp(r.pattern, "i").test(haystack); } catch { return false; }
  }
  return haystack.includes(needle);
}

// Merged per field across every matching rule: the highest-precedence rule that
// sets a field wins that field, so a category rule and a rename rule for the
// same merchant both apply.
export function applyRules(merchant: string | null, name: string): RuleHit {
  const rules = db()
    .prepare(`SELECT * FROM rules ORDER BY ${RULE_ORDER}`)
    .all() as unknown as RuleRow[];

  const hit: RuleHit = {};
  for (const r of rules) {
    if (!ruleMatches(r, merchant, name)) continue;
    if (hit.category === undefined && r.category) hit.category = r.category;
    if (hit.entity === undefined && r.entity) hit.entity = r.entity;
    if (hit.rename === undefined && r.rename) hit.rename = r.rename;
    if (hit.category !== undefined && hit.entity !== undefined && hit.rename !== undefined) break;
  }
  return hit;
}

// --- LLM layer (the tail rules don't cover) ---
// Categorizes transactions whose category came straight from Plaid (coarse),
// in batches, then writes high-confidence answers back as rules so the next
// occurrence is free and deterministic. Never blocks the sync path.

interface LlmTxn { id: string; name: string; merchant: string | null; plaid: string | null; }
interface LlmResult { id: string; category: string; confidence: number }

const SYSTEM = `You categorize personal bank transactions for one person's finance app.
Output ONLY a JSON array, one object per input transaction:
{"id": <the id string>, "category": <one of the allowed categories>, "confidence": <0..1>}.
Allowed categories: ${CATEGORIES.join(", ")}.
Rules: pick the most specific fit. A transfer to a brokerage = Transfer:Brokerage.
Venmo/PayPal/Zelle to a person = Transfer:P2P. Moving money between own accounts =
Transfer:Internal. A credit-card autopay = CreditCardPayment. No prose, no markdown.`;

export async function categorizeWithLlm(opts: { limit?: number; writeRules?: boolean } = {}) {
  const d = db();
  const limit = opts.limit ?? 100;
  const writeRules = opts.writeRules ?? true;

  // Candidates: still on a raw Plaid category (coarse), not yet manually set.
  const rows = d.prepare(
    `SELECT id, name, merchant, plaid_category AS plaid
     FROM transactions
     WHERE category_source = 'plaid'
     ORDER BY date DESC LIMIT ?`
  ).all(limit) as unknown as LlmTxn[];

  if (rows.length === 0) return { processed: 0, updated: 0, rulesAdded: 0 };

  let updated = 0, rulesAdded = 0;
  const BATCH = 25;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const payload = batch.map((t) => ({
      id: t.id,
      name: t.name,
      merchant: t.merchant,
      plaid: t.plaid,
    }));
    const reply = await chat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(payload) },
      ],
      { maxTokens: 1600, reasoning: false }
    );
    const parsed = extractJson<LlmResult[]>(reply);
    if (!Array.isArray(parsed)) continue;

    const setCat = d.prepare(
      `UPDATE transactions SET category=?, category_source='llm', confidence=? WHERE id=?`
    );
    const byId = new Map(batch.map((b) => [b.id, b]));
    for (const r of parsed) {
      if (!r?.id || !r.category) continue;
      // Only write ids we sent in this batch: an echoed or invented id would
      // otherwise overwrite any row, manual picks included.
      if (!byId.has(r.id)) continue;
      if (!CATEGORIES.includes(r.category as never)) continue;
      const conf = typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null;
      setCat.run(r.category, conf, r.id);
      updated++;

      // Write back a rule on high confidence so it's deterministic next time.
      if (writeRules && (conf ?? 0) >= 0.9) {
        const t = byId.get(r.id);
        const merchant = t?.merchant?.trim();
        if (merchant && merchant.length >= 4 && !MULTI_CATEGORY_MERCHANT.test(`${merchant} ${t?.name ?? ""}`)) {
          const exists = d.prepare(
            `SELECT 1 FROM rules WHERE lower(pattern)=lower(?) AND field='merchant'`
          ).get(merchant);
          if (!exists) {
            d.prepare(
              `INSERT INTO rules (match_type, pattern, field, category, source, priority)
               VALUES ('contains', ?, 'merchant', ?, 'llm', 50)`
            ).run(merchant, r.category);
            rulesAdded++;
          }
        }
      }
    }
  }
  return { processed: rows.length, updated, rulesAdded };
}

// One-tap suggestion for a single transaction (the To-Review ✨ Suggest button).
// Read-only: returns the model's best category + confidence. The caller applies
// it via the normal edit path, which then remembers the merchant + backfills.
export async function suggestCategory(
  txnId: string,
): Promise<{ category: string; confidence: number } | null> {
  const d = db();
  const t = d.prepare(
    `SELECT id, name, merchant, plaid_category AS plaid FROM transactions WHERE id=?`,
  ).get(txnId) as { id: string; name: string | null; merchant: string | null; plaid: string | null } | undefined;
  if (!t) return null;

  const reply = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify([{ id: t.id, name: t.name, merchant: t.merchant, plaid: t.plaid }]) },
    ],
    { maxTokens: 200, reasoning: false },
  );
  const parsed = extractJson<{ id: string; category: string; confidence?: number }[]>(reply);
  const hit = Array.isArray(parsed) ? parsed.find((r) => r?.category) : null;
  if (!hit || !CATEGORIES.includes(hit.category as never)) return null;
  return { category: hit.category, confidence: hit.confidence ?? 0.7 };
}
