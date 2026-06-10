// Nightly refresh of live prices for manual holdings. Hits the always-on prod
// server's endpoint so it reuses the app's DB + logic. Run: node scripts/refresh-quotes.mjs
const PORT = process.env.PLAID_PORT ?? "3408";
const res = await fetch(`http://localhost:${PORT}/api/investments/quotes`, { method: "POST" });
const j = await res.json();
if (!res.ok || !j.quotes) {
  console.error("quote refresh failed:", JSON.stringify(j));
  process.exit(1);
}
const { updated, missed, holdingsRepriced } = j.quotes;
console.log(`${new Date().toISOString()} repriced ${holdingsRepriced} holdings · ${updated.length} quotes · missed ${missed.length}${missed.length ? " (" + missed.join(",") + ")" : ""}`);
