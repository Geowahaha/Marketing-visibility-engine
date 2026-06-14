/**
 * Shared LLM caller with automatic provider fallback.
 * ------------------------------------------------------------------
 * Used by scan.js / improve.js / competitor.js for their JSON-generation
 * calls. Tries providers in order and returns the first success, so a single
 * provider outage or rate-limit doesn't break the product.
 *
 * Order: Anthropic (Claude) → Groq → Kimi (Moonshot). A provider is skipped
 * if its key isn't set. Groq + Kimi are OpenAI-compatible chat completions.
 *
 * (Filename starts with "_" so Cloudflare Pages does NOT treat it as a route;
 *  it is still importable by the route functions.)
 *
 * Env:
 *   ANTHROPIC_API_KEY / CLAUDE_MODEL
 *   GROQ_API_KEY      / GROQ_MODEL   (default llama-3.3-70b-versatile)
 *   KIMI_API_KEY      / KIMI_MODEL   (default kimi-k2-0905-preview)
 *                     / KIMI_BASE_URL (default https://api.moonshot.ai/v1)
 *   LLM_PROVIDER_ORDER (optional CSV to override order, e.g. "groq,anthropic")
 */

async function callAnthropic(env, { system, messages, maxTokens, temperature }) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
  });
  if (!resp.ok) return { ok: false, status: resp.status, detail: (await resp.text()).slice(0, 400) };
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { ok: true, text };
}

/** Shared path for OpenAI-compatible providers (Groq, Kimi/Moonshot). */
async function callOpenAICompatible(url, apiKey, model, { system, messages, maxTokens, temperature }) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!resp.ok) return { ok: false, status: resp.status, detail: (await resp.text()).slice(0, 400) };
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  if (!text) return { ok: false, status: 502, detail: "empty_completion" };
  return { ok: true, text };
}

const PROVIDERS = {
  anthropic: {
    key: (env) => env.ANTHROPIC_API_KEY,
    run: (env, args) => callAnthropic(env, args),
  },
  groq: {
    key: (env) => env.GROQ_API_KEY,
    run: (env, args) => callOpenAICompatible(
      "https://api.groq.com/openai/v1/chat/completions",
      env.GROQ_API_KEY,
      env.GROQ_MODEL || "llama-3.3-70b-versatile",
      args
    ),
  },
  kimi: {
    key: (env) => env.KIMI_API_KEY,
    run: (env, args) => callOpenAICompatible(
      `${(env.KIMI_BASE_URL || "https://api.moonshot.ai/v1").replace(/\/+$/, "")}/chat/completions`,
      env.KIMI_API_KEY,
      env.KIMI_MODEL || "kimi-k2-0905-preview",
      args
    ),
  },
};

/**
 * callLLM(env, { system, messages, maxTokens=4000, temperature=0 })
 * → { ok:true, text, provider } | { ok:false, error, detail, status, tried }
 */
export async function callLLM(env, { system, messages, maxTokens = 4000, temperature = 0 }) {
  const order = (env.LLM_PROVIDER_ORDER
    ? String(env.LLM_PROVIDER_ORDER).split(",").map((s) => s.trim().toLowerCase())
    : ["groq", "anthropic"]
  ).filter((name) => PROVIDERS[name] && PROVIDERS[name].key(env));

  if (!order.length) {
    console.error("[llm] No providers in order array. LLM_PROVIDER_ORDER value produced empty list after filtering.");
    return { ok: false, status: 500, error: "No LLM provider configured (set ANTHROPIC_API_KEY, GROQ_API_KEY, or KIMI_API_KEY).", tried: [] };
  }

  console.error(`[llm] Trying providers in order: ${order.join(", ")}`);
  const tried = [];
  for (const name of order) {
    try {
      const r = await PROVIDERS[name].run(env, { system, messages, maxTokens, temperature });
      if (r.ok) {
        console.error(`[llm] SUCCESS via ${name}`);
        return { ok: true, text: r.text, provider: name };
      }
      console.error(`[llm] FAIL ${name}: HTTP ${r.status} — ${String(r.detail || "").slice(0, 300)}`);
      tried.push({ provider: name, status: r.status, detail: r.detail });
    } catch (e) {
      console.error(`[llm] THROW ${name}: ${String(e).slice(0, 200)}`);
      tried.push({ provider: name, error: String(e).slice(0, 160) });
    }
  }
  const last = tried[tried.length - 1] || {};
  console.error(`[llm] All providers failed. tried=${JSON.stringify(tried)}`);
  return { ok: false, status: last.status || 502, error: "All LLM providers failed.", detail: last.detail || last.error, tried };
}
