/**
 * Cloudflare Pages Function — POST /api/render-check  (Human vs AI-bot view)
 * ------------------------------------------------------------------
 * The premium differentiator. Most AI crawlers (GPTBot, ClaudeBot, Perplexity,
 * OAI-SearchBot) do NOT execute JavaScript — they read raw HTML. So for a
 * JS-rendered site, a human sees a full page while the AI bot sees almost
 * nothing. This proves that gap:
 *
 *   - raw fetch (what a JS-less AI bot gets) → readable text length
 *   - Cloudflare Browser Rendering (what a human/JS browser gets) → text length
 *   - the difference = content invisible to AI bots, + an optional screenshot.
 *
 * Uses the Browser Rendering REST API (no puppeteer bundle). Paid-gated and
 * best run only when /api/bot-access flags JS-render risk (rendering costs).
 *
 * Env:
 *   CF_ACCOUNT_ID        (required — your Cloudflare account id)
 *   BROWSER_API_TOKEN    (required — token with "Browser Rendering: Edit";
 *                         falls back to Render_CF_KEY / CF_API_TOKEN)
 *   PAID_EXPORT_SECRET / *_BYPASS_IPS (unlock)
 * Requires Workers Paid plan with Browser Rendering enabled.
 */

import { paidStatus } from "./_auth.js";
import { checkCreditBalance, consumeCredits, creditCost } from "./_credits.js";
import { signedFetch } from "./_botauth.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const AIMARK_UA = "AIBotAuth/1.0 (+https://aibotauth.com/bot; site-owner-requested audit)";

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

function textOf(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function rawFetch(env, url) {
  try {
    const r = await signedFetch(env, url, { headers: { "User-Agent": AIMARK_UA }, redirect: "follow", cf: { cacheTtl: 0 } });
    return textOf(await r.text());
  } catch { return ""; }
}

function cfAccountId(env = {}) {
  return env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || env.Cloudfaire_Account_ID;
}

function browserRenderingToken(env = {}) {
  return (
    env.BROWSER_API_TOKEN ||
    env.Render_CF_KEY ||
    env.RENDER_CF_KEY ||
    env.CF_BROWSER_RENDERING_TOKEN ||
    env.CF_API_TOKEN ||
    env.Cloudfaire_API_TOKEN ||
    env.Cloudfaire_API
  );
}

function browserRenderingEnvStatus(env = {}) {
  const tokenKeys = [
    "BROWSER_API_TOKEN",
    "Render_CF_KEY",
    "RENDER_CF_KEY",
    "CF_BROWSER_RENDERING_TOKEN",
    "CF_API_TOKEN",
    "Cloudfaire_API_TOKEN",
    "Cloudfaire_API",
  ];
  const tokenSource = tokenKeys.find((key) => !!env[key]) || "";
  return {
    cf_account_id_present: !!cfAccountId(env),
    token_present: !!tokenSource,
    token_source: tokenSource,
    required_token_scope: "Cloudflare Account > Browser Rendering: Edit",
    required_plan: "Workers Paid plan with Browser Rendering enabled",
  };
}

function browserRenderingSetupMessage(status, diagnostic) {
  if (!diagnostic?.cf_account_id_present && !diagnostic?.token_present) {
    return "Missing CF_ACCOUNT_ID and BROWSER_API_TOKEN. Set both before Human-vs-AI render proof can run.";
  }
  if (!diagnostic?.cf_account_id_present) {
    return "Missing CF_ACCOUNT_ID. Set the Cloudflare account id that owns Browser Rendering.";
  }
  if (!diagnostic?.token_present) {
    return "Missing BROWSER_API_TOKEN. Set a Cloudflare token with Browser Rendering: Edit permission.";
  }
  if (status === 401) {
    return "BROWSER_API_TOKEN is present, but Cloudflare returned 401. Check the token value, expiry, and that it belongs to CF_ACCOUNT_ID.";
  }
  if (status === 403) {
    return "BROWSER_API_TOKEN is present, but Cloudflare returned 403. Check Browser Rendering: Edit scope, account permissions, and Workers Paid/Browser Rendering enablement.";
  }
  return "Cloudflare Browser Rendering is not ready.";
}

async function brEndpoint(env, path, body, asImage = false, timeoutMs = 30000) {
  const account = cfAccountId(env);
  const token = browserRenderingToken(env);
  const diagnostic = browserRenderingEnvStatus(env);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (asImage) {
      if (!r.ok) return { ok: false, status: r.status, detail: (await r.text()).slice(0, 300), diagnostic };
      const buf = new Uint8Array(await r.arrayBuffer());
      return { ok: true, bytes: buf };
    }
    const d = await r.json();
    if (!r.ok || d.success === false) return { ok: false, status: r.status, detail: JSON.stringify(d.errors || d).slice(0, 300), diagnostic };
    return { ok: true, result: d.result };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e).slice(0, 200), diagnostic };
  } finally { clearTimeout(t); }
}

function b64(bytes) {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const status = await paidStatus(request, env);
  if (!status.paid) {
    return json({ error: "Deep render (Human vs AI-bot view) is part of AI Mark Pro.", upgrade_required: true, checkout_url: "/api/checkout?product=pro" }, 402);
  }
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a URL." }, 400);

  const renderDiagnostic = browserRenderingEnvStatus(env);
  if (!cfAccountId(env) || !browserRenderingToken(env)) {
    return json({
      live: false,
      setup_required: browserRenderingSetupMessage(0, renderDiagnostic),
      diagnostic: renderDiagnostic,
      note: "Until then, /api/bot-access still flags JS-render risk heuristically.",
    }, 200);
  }

  let creditCharge = null;
  const creditDebit = status.reason === "credit_balance" ? {
    feature: "render_check",
    amount: creditCost("render_check"),
    idempotency_key: `render_check:${url}:${payload.screenshot === false ? "content" : "screenshot"}`,
    metadata: { url, screenshot: payload.screenshot !== false },
  } : null;
  if (status.reason === "credit_balance") {
    const creditPreflight = await checkCreditBalance(request, env, creditDebit);
    if (!creditPreflight.ok) {
      return json({
        error: creditPreflight.error || "credit_debit_failed",
        upgrade_required: true,
        checkout_url: creditPreflight.checkout_url || "/?modal=credits",
        credits_required: creditPreflight.amount || creditCost("render_check"),
        credits_balance: creditPreflight.balance ?? null,
        credits_needed: creditPreflight.needed ?? null,
      }, 402);
    }
  }

  // What the human/browser sees vs what a JS-less AI bot sees.
  const [rawText, content] = await Promise.all([
    rawFetch(env, url),
    brEndpoint(env, "content", { url }),
  ]);

  if (!content.ok) {
    const unauth = content.status === 401 || content.status === 403;
    return json({
      live: false,
      error: unauth ? "browser_rendering_unauthorized" : "browser_rendering_failed",
      detail: content.detail,
      setup_required: unauth ? browserRenderingSetupMessage(content.status, content.diagnostic || renderDiagnostic) : undefined,
      diagnostic: content.diagnostic || renderDiagnostic,
      credit_charge: null,
      credit_note: "No credits were debited because Browser Rendering did not return a usable result.",
    }, unauth ? 200 : 502);
  }

  if (creditDebit) {
    creditCharge = await consumeCredits(request, env, creditDebit);
    if (!creditCharge.ok) {
      return json({
        error: creditCharge.error || "credit_debit_failed",
        upgrade_required: true,
        checkout_url: creditCharge.checkout_url || "/?modal=credits",
        credits_required: creditCharge.amount || creditCost("render_check"),
        credits_balance: creditCharge.balance ?? null,
        credits_needed: creditCharge.needed ?? null,
      }, 402);
    }
  }

  const renderedText = textOf(content.result);
  const rawLen = rawText.length, renLen = renderedText.length;
  const hiddenPct = renLen > 0 ? Math.max(0, Math.round((renLen - rawLen) / renLen * 100)) : 0;
  let verdict, headline;
  if (renLen > 800 && rawLen < renLen * 0.5) { verdict = "significant_js_gap"; headline = `~${hiddenPct}% of your content is invisible to JS-less AI bots — they see ${rawLen} chars, humans see ${renLen}.`; }
  else if (renLen > 400 && rawLen < renLen * 0.8) { verdict = "some_js_gap"; headline = `Some content (~${hiddenPct}%) only appears after JavaScript; AI bots may miss it.`; }
  else { verdict = "minimal_gap"; headline = `AI bots and humans see roughly the same content (${rawLen} vs ${renLen} chars). Good.`; }

  // Best-effort screenshot of the human view.
  let screenshot = null;
  if (payload.screenshot !== false) {
    const shot = await brEndpoint(env, "screenshot", { url, viewport: { width: 1280, height: 800 }, screenshotOptions: { type: "jpeg", quality: 70 } }, true, 30000);
    if (shot.ok && shot.bytes && shot.bytes.length < 1500000) screenshot = "data:image/jpeg;base64," + b64(shot.bytes);
  }

  return json({
    url,
    live: true,
    checked_at: new Date().toISOString(),
    bot_view_chars: rawLen,
    human_view_chars: renLen,
    hidden_from_ai_pct: hiddenPct,
    verdict,
    headline,
    paid_reason: status.reason,
    credit_charge: creditCharge,
    bot_view_sample: rawText.slice(0, 400),
    human_view_sample: renderedText.slice(0, 400),
    screenshot,
    honest_note: "Most AI crawlers don't run JavaScript, so the raw-fetch view approximates what they index. The rendered view is what a human browser sees. A large gap means JS-only content that AI engines likely never read.",
  });
}
