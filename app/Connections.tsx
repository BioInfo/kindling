"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { panel } from "./ui";

type Conn = {
  id: string; institution: string | null; status: string; error: string | null;
  last_synced_at: string | null; accounts: number; stale: boolean;
};

// Banner for bank connections that stopped syncing. Reconnect opens Plaid Link
// in UPDATE mode on the same item, so logging back in never creates a second
// copy of the accounts (fresh "Connect a bank" for the same bank did exactly that).
export function ConnectionHealth({ refreshKey, onFixed }: { refreshKey: number; onFixed: () => void }) {
  const [conns, setConns] = useState<Conn[]>([]);
  useEffect(() => {
    fetch("/api/connections").then((r) => r.json()).then((d) => setConns(d.connections ?? [])).catch(() => setConns([]));
  }, [refreshKey]);
  const bad = conns.filter((c) => c.status === "re-auth" || c.status === "error" || c.stale);
  if (!bad.length) return null;
  return (
    <div className="mb-4 space-y-2 rounded-xl p-3" style={{ ...panel, borderColor: "var(--warn)" }}>
      <div className="text-sm font-medium" style={{ color: "var(--warn)" }}>
        {bad.length === 1 ? "1 bank connection needs attention" : `${bad.length} bank connections need attention`}
      </div>
      {bad.map((c) => <ConnRow key={c.id} c={c} onFixed={onFixed} />)}
    </div>
  );
}

function why(c: Conn): string {
  if (c.status === "re-auth") return "logged out — sign in again to resume syncing";
  if (c.status === "error") return `sync failing${c.error ? ` (${c.error.split(":")[0]})` : ""}`;
  return `not synced since ${c.last_synced_at?.slice(0, 10) ?? "link"}`;
}

function ConnRow({ c, onFixed }: { c: Conn; onFixed: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/link/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: c.id, mode: "reauth" }),
    }).then((r) => r.json()).then((d) => d.link_token ? setToken(d.link_token) : setErr(d.error ?? d.message ?? "can't reconnect"))
      .catch(() => setErr("request failed"));
  }, [c.id]);
  const onSuccess = useCallback(() => onFixed(), [onFixed]);
  const { open, ready } = usePlaidLink({ token: token ?? "", onSuccess });
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div className="min-w-0">
        <span className="font-medium">{c.institution ?? "Bank"}</span>
        <span style={{ color: "var(--muted)" }}> · {c.accounts} acct{c.accounts === 1 ? "" : "s"} · {why(c)}</span>
        {err && <div className="text-xs" style={{ color: "var(--bad)" }}>{err}</div>}
      </div>
      <button onClick={() => open()} disabled={!ready || !token}
        className="min-h-9 rounded-lg px-3 py-1.5 font-medium"
        style={{ background: "var(--accent-deep)", color: "white", opacity: ready && token ? 1 : 0.5 }}>
        Reconnect
      </button>
    </div>
  );
}
