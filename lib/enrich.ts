import { reconcileSubscriptions, autoMergeSubscriptions, labelSubscriptions, classifySubscriptionTypes } from "./subscriptions";

// Upkeep that runs after every sync so the Subscriptions surface stays tidy by
// itself: re-detect, fold duplicate descriptors together, label what the rules
// can tell, then (opt-in) a small capped LLM batch for the rest. Idempotent:
// a second run with nothing new changes nothing. Never throws; a failed step is
// reported in the result and the later steps still run.
//
// reconcile runs without Plaid here: sync.ts already does the Plaid recurring
// pull right before this, and a second network pull per sync buys nothing.
export type EnrichResult = {
  merged: number; typed: number; categorized: number;
  llm: { processed: number; updated: number } | null;
  errors: string[];
  ms: number;
};

const LLM_CAP = 20;          // rows per sync; the rest wait for the next one
const LLM_TIMEOUT_MS = 20_000;

// reconcile:false skips detection, for a caller that just reconciled itself
// (the Subscriptions GET route, which may have pulled Plaid).
export async function postSyncEnrich(opts: { llm: boolean; reconcile?: boolean }): Promise<EnrichResult> {
  const t0 = Date.now();
  const out: EnrichResult = { merged: 0, typed: 0, categorized: 0, llm: null, errors: [], ms: 0 };
  const step = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try { await fn(); } catch (e) { out.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  if (opts.reconcile !== false) await step("reconcile", () => reconcileSubscriptions({ plaid: false }));
  // Label first so a transfer is typed before merge evidence is weighed, then
  // again after merge so a new parent row is labelled too (cheap, idempotent).
  await step("label", () => { const r = labelSubscriptions(); out.typed += r.typed; out.categorized += r.categorized; });
  await step("merge", () => { out.merged = autoMergeSubscriptions().merged.length; });
  await step("label", () => { const r = labelSubscriptions(); out.typed += r.typed; out.categorized += r.categorized; });
  if (opts.llm) {
    // One sequential call on the thinking-off lane (classifySubscriptionTypes
    // passes reasoning:false); fills only rows still untyped, never a user edit.
    await step("llm", async () => {
      out.llm = await classifySubscriptionTypes({ limit: LLM_CAP, batch: LLM_CAP, timeoutMs: LLM_TIMEOUT_MS });
    });
  }
  out.ms = Date.now() - t0;
  return out;
}
