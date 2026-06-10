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
      // Non-reasoning: OpenRouter honors reasoning.enabled=false on the
      // deepseek-flash route. Keeps replies fast + structured (no reasoning
      // tokens eating the small max_tokens budget). Ignored by models that
      // do not support it.
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
  return data.choices?.[0]?.message?.content ?? "";
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
