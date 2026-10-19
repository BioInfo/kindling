// Pull order receipts (Gmail via gog, read-only; plus any data/*order*.csv) into
// order_receipts and match them to card charges. Idempotent and incremental.
//   FINANCE_DB_PATH=... ORDERS_GMAIL_ACCOUNT=you@gmail.com npx tsx scripts/fetch-orders.mts [--since-days 400] [--csv path]
if (!process.env.FINANCE_DB_PATH) throw new Error("set FINANCE_DB_PATH explicitly");
const { fetchGmailReceipts, importOrdersCsv, matchReceipts } = await import("../lib/orders.ts");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

if (process.env.ORDERS_GMAIL_ACCOUNT) {
  const r = await fetchGmailReceipts({ sinceDays: Number(arg("--since-days") ?? 400), rescan: process.argv.includes("--rescan") });
  console.log("gmail:", r);
} else {
  console.log("gmail: skipped (ORDERS_GMAIL_ACCOUNT not set)");
}
console.log("csv:", importOrdersCsv(arg("--csv")));
console.log("match:", matchReceipts());
