import { config } from "./config";

// Thin client for any OpenAI-compatible gateway (LiteLLM, vLLM, Ollama, a hosted
// provider). Model is swappable via FINANCE_LLM_MODEL — point it at a model served
// on your own network if you want financial data to never leave it.

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(
  messages: ChatMsg[],
  opts: { maxTokens?: number; temperature?: number; model?: string; timeoutMs?: number } = {}
): Promise<string> {
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? config.llm.model,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1024,
      messages,
      // Non-reasoning. `thinking: {type:"disabled"}` is the one shape this
      // gateway actually honors on deepseek-flash: measured 2026-09-19,
      // reasoning_tokens 0 with it, 131-495 without. `reasoning.enabled=false`
      // and `reasoning_effort:"none"` are BOTH silently ignored here — they
      // return HTTP 200 and reason anyway. Kept alongside for a provider swap
      // (OpenRouter reads the reasoning shape); unknown keys are dropped.
      // Reasoning tokens are billed against max_tokens, so an ignored flag
      // spends the whole budget thinking and returns content: null.
      thinking: { type: "disabled" },
      reasoning: { enabled: false },
    }),
    // Cold-start of the on-demand NVFP4 vLLM can take ~30-60s on first call.
    // Default cap 90s: long enough for a real cold-start, short enough to fail
    // cleanly when the model is down rather than hanging the UI. An explicit
    // timeoutMs overrides it — out-of-band callers (the insights lede) pass a
    // larger budget so a cold boot still completes and caches, off the UI path.
    signal: AbortSignal.timeout(opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 90_000)),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM gateway ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? "";
  // A truncated reply is not an empty one. When the model burns max_tokens on
  // reasoning, content comes back null with finish_reason "length" — the caller
  // then reports "could not parse model reply", which points at the parser and
  // not at the budget. Name the real fault. (Measured 2026-09-19: 5 of 8 identify
  // calls truncated at max_tokens 500 with 482 reasoning tokens.)
  if (!content && choice?.finish_reason === "length") {
    const rt = data.usage?.completion_tokens_details?.reasoning_tokens;
    throw new Error(
      `LLM reply truncated at max_tokens (finish_reason=length` +
      (rt ? `, ${rt} reasoning tokens` : "") +
      `) — raise maxTokens or disable reasoning for this model.`
    );
  }
  return content;
}

// Pulls the first JSON array or object out of a model reply, tolerating
// markdown fences and stray prose. Works across models (qwen emits bare JSON,
// gemini wraps in ```json fences, some add a preamble). Never trust the raw tail.
export function extractJson<T = unknown>(text: string): T | null {
  // 1. Strip markdown code fences.
  let s = text.replace(/```(?:json)?/gi, "").trim();

  // 2. Fast path: the whole thing is valid JSON.
  try { return JSON.parse(s) as T; } catch { /* fall through */ }

  // 3. Find the first { or [ and scan for its balanced close, respecting
  //    strings/escapes so braces inside SQL values don't fool us.
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  s = s.slice(start);
  const open = s[0];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(0, i + 1)) as T; } catch { return null; }
      }
    }
  }
  return null;
}
