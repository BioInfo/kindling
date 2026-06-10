#!/usr/bin/env python3
"""Weekly Kindling digest emailer.

Regenerates this week's summary via the always-on prod API (so all the SQL +
local-model narration logic lives in one place, not duplicated here), then
either prints it (default, dry-run) or emails it via Resend (--send).

Secrets: the Resend API key is read from `pass api-keys/resend` at run time,
never from a file. Recipient/sender come from env so nothing personal is
hard-coded:
    PLAID_DIGEST_TO     recipient address (required for --send)
    PLAID_DIGEST_FROM   verified Resend sender (required for --send)
    PLAID_API           base URL of the running app (default http://localhost:3408)

Usage:
    ./scripts/weekly-summary.py            # dry-run: regenerate + print subject/body
    ./scripts/weekly-summary.py --send     # regenerate + email via Resend
"""
import json
import os
import subprocess
import sys
import urllib.request

API = os.environ.get("PLAID_API", "http://localhost:3408")
# Mirror the app's gateway/model defaults (lib/config.ts) so the warmup below
# targets the exact model /api/summary will narrate with.
GATEWAY = os.environ.get("LITELLM_BASE_URL", "http://localhost:4000/v1")
MODEL = os.environ.get("FINANCE_LLM_MODEL", "deepseek-v4-flash")


def warm_model() -> None:
    """Boot the on-demand NVFP4 model before generating.

    The model is reaped after ~15 min idle, so an unattended run almost always
    hits it cold. /api/summary aborts its LLM call at 90s (lib/llm.ts), but a
    cold NVFP4 boot can exceed that and 502 the whole digest. We can't retry
    from inside the agent, so we absorb the boot here first: one cheap call with
    a generous timeout that blocks until vLLM is ready. After it returns, the
    summary narration runs warm in ~2s. Warmup failures are non-fatal — fall
    through and let fetch_summary surface its own error.
    """
    key = subprocess.run(
        ["pass", "api-keys/litellm-vk-finance"], capture_output=True, text=True
    ).stdout.strip().splitlines()
    if not key or not key[0]:
        print("warm: no vk-finance key in pass — skipping warmup", file=sys.stderr)
        return
    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": "ok"}],
        "max_tokens": 1,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        f"{GATEWAY}/chat/completions",
        data=payload,
        headers={"Authorization": f"Bearer {key[0]}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        # Generous: a cold model boot can run well past the app's 90s LLM cap.
        with urllib.request.urlopen(req, timeout=int(os.environ.get("WARM_TIMEOUT", "300"))) as r:
            r.read()
        print(f"warm: {MODEL} ready", file=sys.stderr)
    except Exception as e:  # noqa: BLE001 — warmup is best-effort, never fatal
        print(f"warm: {MODEL} warmup failed ({e}) — continuing", file=sys.stderr)


def fetch_summary() -> dict:
    req = urllib.request.Request(
        f"{API}/api/summary",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=150) as r:
        data = json.load(r)
    if "error" in data:
        sys.exit(f"summary generation failed: {data['error']}")
    return data


def subject(summary: dict) -> str:
    st = summary["stats"]
    spend = st["spend"]["thisWeek"]
    return f"Kindling — week of {summary['weekStart']}: ${spend:,.2f} spent"


def send_via_resend(to: str, frm: str, subj: str, html: str) -> None:
    key = subprocess.run(
        ["pass", "api-keys/resend"], capture_output=True, text=True
    ).stdout.strip().splitlines()
    if not key or not key[0]:
        sys.exit("no Resend key in `pass api-keys/resend`")
    payload = json.dumps({"from": frm, "to": [to], "subject": subj, "html": html}).encode()
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {key[0]}",
            "Content-Type": "application/json",
            # Resend sits behind Cloudflare, which 403s (error 1010) on urllib's
            # default User-Agent. A named UA passes.
            "User-Agent": "kindling-weekly/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        sys.exit(f"Resend {e.code}: {body}")
    print(f"sent: id={res.get('id')}")


def main() -> None:
    send = "--send" in sys.argv[1:]
    warm_model()          # absorb a cold model boot before the bounded summary call
    data = fetch_summary()
    summary = data["summary"]
    html = data.get("emailHtml", "")
    subj = subject(summary)

    if not send:
        print(f"[dry-run] subject: {subj}")
        print(f"[dry-run] week:    {summary['weekStart']} -> {summary['weekEnd']}")
        print(f"[dry-run] model:   {summary.get('model')}")
        print("[dry-run] narrative:\n" + summary["narrative"])
        print(f"[dry-run] html:    {len(html)} bytes (not sent — pass --send to email)")
        return

    to = os.environ.get("PLAID_DIGEST_TO", "")
    frm = os.environ.get("PLAID_DIGEST_FROM", "")
    if not to or not frm:
        sys.exit("set PLAID_DIGEST_TO and PLAID_DIGEST_FROM to send")
    send_via_resend(to, frm, subj, html)


if __name__ == "__main__":
    main()
