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
  affected: { id: string; prevCategory: string | null; prevSource: string | null }[];
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
  const like = `%${pattern.toLowerCase()}%`;
  const haystack = field === "name" ? "lower(name)" : "lower(COALESCE(NULLIF(merchant,''), name))";
  const siblings = d.prepare(
    `SELECT id, category, category_source FROM transactions
     WHERE ${haystack} LIKE ? AND id != ? AND COALESCE(category_source,'') != 'manual'
       AND COALESCE(category,'') != ?`
  ).all(like, txnId, category) as { id: string; category: string | null; category_source: string | null }[];

  const setCat = d.prepare(
    `UPDATE transactions SET category=?, category_source='rule', confidence=1.0 WHERE id=?`
  );
  const affected = siblings.map((s) => {
    setCat.run(category, s.id);
    return { id: s.id, prevCategory: s.category, prevSource: s.category_source };
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
  const restore = d.prepare(`UPDATE transactions SET category=?, category_source=? WHERE id=?`);
  for (const a of undo.affected) restore.run(a.prevCategory, a.prevSource, a.id);
}

// --- Rule layer (deterministic, user-editable, runs on every sync) ---
export function applyRules(merchant: string | null, name: string): RuleHit {
  const d = db();
  const rules = d
    .prepare(`SELECT * FROM rules ORDER BY priority ASC, id ASC`)
    .all() as unknown as {
    match_type: string;
    pattern: string;
    field: string;
    category: string | null;
    entity: string | null;
    rename: string | null;
  }[];

  const merchantText = (merchant ?? "").toLowerCase();
  const nameText = name.toLowerCase();

  for (const r of rules) {
    const haystack = r.field === "name" ? nameText : merchantText || nameText;
    const needle = r.pattern.toLowerCase();
    let matched = false;
    if (r.match_type === "exact") matched = haystack === needle;
    else if (r.match_type === "regex") {
      try { matched = new RegExp(r.pattern, "i").test(haystack); } catch { matched = false; }
    } else matched = haystack.includes(needle);

    if (matched) {
      return {
        category: r.category ?? undefined,
        entity: r.entity ?? undefined,
        rename: r.rename ?? undefined,
      };
    }
  }
  return {};
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
      { maxTokens: 1600 }
    );
    const parsed = extractJson<LlmResult[]>(reply);
    if (!Array.isArray(parsed)) continue;

    const setCat = d.prepare(
      `UPDATE transactions SET category=?, category_source='llm', confidence=? WHERE id=?`
    );
    const byId = new Map(batch.map((b) => [b.id, b]));
    for (const r of parsed) {
      if (!r?.id || !r.category) continue;
      if (!CATEGORIES.includes(r.category as never)) continue;
      setCat.run(r.category, r.confidence ?? null, r.id);
      updated++;

      // Write back a rule on high confidence so it's deterministic next time.
      if (writeRules && (r.confidence ?? 0) >= 0.9) {
        const t = byId.get(r.id);
        const merchant = t?.merchant?.trim();
        if (merchant && merchant.length >= 3) {
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
    { maxTokens: 200 },
  );
  const parsed = extractJson<{ id: string; category: string; confidence?: number }[]>(reply);
  const hit = Array.isArray(parsed) ? parsed.find((r) => r?.category) : null;
  if (!hit || !CATEGORIES.includes(hit.category as never)) return null;
  return { category: hit.category, confidence: hit.confidence ?? 0.7 };
}
