// Checks the Plaid error classifier and that the post-sync dedupe is a no-op on
// a clean db. FINANCE_DB_PATH should point at a copy.
import { classifyPlaidError } from "../lib/plaid.ts";
import { dedupeMergedTransactions } from "../lib/relink.ts";
const ok = (l: string, c: boolean) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) process.exitCode = 1; };
const ax = (code: string) => ({ message: "Request failed with status code 400", response: { data: { error_code: code, error_message: "the login details have changed" } } });
ok("ITEM_LOGIN_REQUIRED -> re-auth", classifyPlaidError(ax("ITEM_LOGIN_REQUIRED")).status === "re-auth");
ok("message carries the code", classifyPlaidError(ax("ITEM_LOGIN_REQUIRED")).message.startsWith("ITEM_LOGIN_REQUIRED:"));
ok("RATE_LIMIT_EXCEEDED -> error", classifyPlaidError(ax("RATE_LIMIT_EXCEEDED")).status === "error");
ok("plain Error -> error", classifyPlaidError(new Error("boom")).status === "error");
ok("dedupe idempotent on merged db", dedupeMergedTransactions() === 0);
