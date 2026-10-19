// Rule-precedence and alert-noise checks against a COPY of a real db. Every
// write happens inside one transaction that is rolled back, so the copy is
// unchanged afterwards. Needs the config env vars (dummy values are fine; no
// network is called):
//   FINANCE_DB_PATH=/path/to/snapshot-copy.db PLAID_CLIENT_ID=x PLAID_SECRET=x \
//   APP_ENC_KEY=$(printf '0%.0s' {1..64}) npx tsx scripts/verify-tidy.mts
const dbPath = process.env.FINANCE_DB_PATH ?? "";
if (!dbPath || /data\/finance\.db$/.test(dbPath)) throw new Error("set FINANCE_DB_PATH to a copy, never the live db");

const { db } = await import("../lib/db.ts");
const { applyRules } = await import("../lib/categorize.ts");
const { POST: createRule } = await import("../app/api/rules/route.ts");
const { NextRequest } = await import("next/server");

const ok = (l: string, c: boolean, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${extra ? " — " + extra : ""}`); if (!c) process.exitCode = 1; };

// ---- Local dates (TZ_LOCAL defaults to America/New_York).
const { todayLocal, monthLocal, addMonths } = await import("../lib/dates.ts");
const evening = new Date("2026-10-31T01:30:00Z"); // 9:30pm EDT on Oct 30
ok("9:30pm ET is still today, not tomorrow", todayLocal(evening) === "2026-10-30", todayLocal(evening));
const lastEve = new Date("2026-11-01T02:00:00Z"); // 10pm EDT on Oct 31
ok("last evening of a month is still that month", monthLocal(lastEve) === "2026-10", monthLocal(lastEve));
ok("winter offset: 7:30pm EST on Dec 31 is still 2026", todayLocal(new Date("2027-01-01T00:30:00Z")) === "2026-12-31");
ok("addMonths wraps the year", addMonths("2026-01", -1) === "2025-12" && addMonths("2026-11", 2) === "2027-01");
const d = db();
const rule = d.prepare(`INSERT INTO rules (match_type, pattern, field, category, entity, rename, priority, source) VALUES (?,?,?,?,?,?,?,?)`);
const insTxn = d.prepare(
  `INSERT INTO transactions (id, account_id, date, name, merchant, amount, category, category_source, confidence)
   VALUES (?, (SELECT id FROM accounts LIMIT 1), '2026-01-01', ?, ?, 1, 'Shopping', 'plaid', 0.5)`,
);
const cat = (id: string) => (d.prepare(`SELECT category FROM transactions WHERE id=?`).get(id) as { category: string }).category;

d.exec("BEGIN");
try {
  // ---- Task 2: rule precedence + per-field merge.
  rule.run("contains", "zzverify llm", "merchant", "Dining", null, null, 50, "llm");
  rule.run("contains", "zzverify llm", "merchant", "Groceries", null, null, 100, "manual");
  ok("user rule (priority 100) beats LLM rule (priority 50)", applyRules("zzverify llm", "x").category === "Groceries",
    `got ${applyRules("zzverify llm", "x").category}`);

  // Real rules on the snapshot: 145 (manual, prio 10, category only) and 141
  // (manual, prio 100, rename). Both should apply.
  const jl = applyRules("Jiffy Lube", "JIFFY LUBE #1234");
  ok("Jiffy Lube: category from rule 145 and rename from rule 141 both apply", jl.category === "Transportation" && jl.rename === "Jiffy Lube",
    JSON.stringify(jl));
  // LLM rule 6 (merchant "Pennymac") used to shadow user rule 61's rename.
  const pm = applyRules("Pennymac", "PENNYMAC CASH");
  ok("PennyMac: user rule 61's rename survives LLM rule 6", pm.rename === "PennyMac Mortgage", JSON.stringify(pm));

  // ---- Task 2: "apply now" honours match type and treats % / _ literally.
  insTxn.run("zzv-1", "ZZEXACT", "zzexact");
  insTxn.run("zzv-2", "ZZEXACT PLUS", "zzexact plus");
  insTxn.run("zzv-3", "ZZAXB", "zzaxb");
  insTxn.run("zzv-4", "ZZA_B", "zza_b");
  const post = (b: object) => createRule(new NextRequest("http://local/api/rules", { method: "POST", body: JSON.stringify(b) }));
  await post({ match_type: "exact", pattern: "zzexact", category: "Travel", applyNow: true });
  ok("apply-now exact rule changes only the exact match", cat("zzv-1") === "Travel" && cat("zzv-2") === "Shopping",
    `zzexact=${cat("zzv-1")} zzexact plus=${cat("zzv-2")}`);
  await post({ match_type: "contains", pattern: "zza_b", category: "Travel", applyNow: true });
  ok("apply-now treats _ literally", cat("zzv-4") === "Travel" && cat("zzv-3") === "Shopping",
    `zza_b=${cat("zzv-4")} zzaxb=${cat("zzv-3")}`);

  // ---- Task 4: alert noise. Real snapshot rows plus fixtures dated this week.
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const fx = d.prepare(
    `INSERT INTO transactions (id, account_id, date, name, merchant, amount, category, category_source, confidence)
     VALUES (?, (SELECT id FROM accounts LIMIT 1), ?, ?, ?, ?, 'Shopping', 'rule', 1.0)`,
  );
  // A real double-bill: monthly $49.99, then charged twice two days apart.
  for (const n of [92, 62, 32]) fx.run(`zzn-${n}`, day(n), "ZZSTREAM", "ZZSTREAM", 49.99);
  fx.run("zzn-a", day(4), "ZZSTREAM", "ZZSTREAM", 49.99);
  fx.run("zzn-b", day(3), "ZZSTREAM", "ZZSTREAM", 49.99);
  // One cluster: three identical $80 charges within 3 days of each other.
  for (const n of [5, 4, 3]) fx.run(`zzc-${n}`, day(n), "ZZCLUSTER", "ZZCLUSTER", 80);

  const { detectAnomalies } = await import("../lib/anomalies.ts");
  const an = detectAnomalies({ windowDays: 30 });
  const dupes = an.filter((a) => a.kind === "duplicate");
  const has = (re: RegExp) => dupes.some((a) => re.test(a.detail));
  ok("no duplicate flag for $3 MTA fares", !has(/ at MTA /), dupes.map((a) => a.detail).join(" | "));
  ok("no duplicate flag for $10 Apple Cash / Opencode", !has(/APPLE CASH|Opencode/i));
  ok("no duplicate flag for the habitual Venmo $1,289 transfer", !has(/Venmo/));
  ok("a real double-bill still fires (positive control)", has(/ZZSTREAM/));
  const cl = dupes.filter((a) => /ZZCLUSTER/.test(a.detail));
  ok("a 3-charge cluster is one flag", cl.length === 1 && /3×/.test(cl[0]?.detail ?? ""), cl.map((a) => a.detail).join(" | "));
  const spikes = an.filter((a) => a.kind === "spike");
  ok("ordinary Amazon orders are not spikes", !spikes.some((a) => a.merchant === "Amazon"), spikes.map((a) => a.detail).join(" | "));
  ok("Washington Gas 9× its usual still spikes (positive control)", spikes.some((a) => a.merchant === "Washington Gas"));

  // Insights: page through the whole feed by dismissing each page in turn.
  const { gatherInsights } = await import("../lib/insights.ts");
  const { listSubscriptions } = await import("../lib/subscriptions.ts");
  const dismiss = d.prepare(`INSERT OR IGNORE INTO dismissed_insights (insight_id) VALUES (?)`);
  const keys: string[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const page = gatherInsights();
    if (!page.length) break;
    for (const i of page) { keys.push(i.key); dismiss.run(i.key); }
  }
  const obligations = listSubscriptions().subs.filter((s) => s.type === "obligation" && s.state === "active" && !s.isActive && s.monthly >= 1);
  const leaked = obligations.filter((s) => keys.some((k) => k.startsWith(`sub-unused:${s.id}:`)));
  ok(`no "looks unused" insight for an obligation (${obligations.length} candidates)`, obligations.length > 0 && leaked.length === 0,
    leaked.map((s) => s.merchant).join(", "));
} finally {
  d.exec("ROLLBACK");
}
