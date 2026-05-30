/**
 * Cloudflare Pages Function — POST /api/scan
 * ------------------------------------------------------------------
 * Runs server-side (no CORS limits), fetches the target site's real
 * signals (HTML head, robots.txt, sitemap.xml, llms.txt), then asks
 * Claude to analyse them against the 2026 visibility model + the
 * user's free-text prompt, and returns a strict-JSON "scan" object
 * that the front-end renders into the dashboard.
 *
 * Required environment variable (set in Cloudflare dashboard, NOT in code):
 *   ANTHROPIC_API_KEY   - your Anthropic API key
 * Optional:
 *   CLAUDE_MODEL        - defaults to claude-sonnet-4-6
 *   RATE_LIMIT_MAX          - scans allowed per IP per window (default 5)
 *   RATE_LIMIT_BYPASS_IPS   - comma-separated tester IPs that skip rate limit
 * Optional KV binding (recommended before going public):
 *   RATE_LIMIT_KV           - a KV namespace used to count scans per IP.
 *                         If unbound, rate limiting is skipped (fail-open).
 */

const DEFAULT_MODEL = "claude-sonnet-4-6";
const RATE_WINDOW_SEC = 3600;          // 1 hour
const RATE_LIMIT_DEFAULT = 5;          // scans per IP per window
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 VisibilityEngine/1.0";

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

/**
 * Sliding fixed-window limiter keyed by client IP, stored in KV.
 * Returns {allowed, remaining, resetIn}. Fails OPEN (allows) if KV is missing
 * or errors, so a deploy without the binding still works — just unprotected.
 */
function isRateLimitBypassed(env, ip) {
  if (!ip || !env.RATE_LIMIT_BYPASS_IPS) return false;
  return String(env.RATE_LIMIT_BYPASS_IPS)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .includes(ip);
}

async function checkRateLimit(env, ip) {
  const max = parseInt(env.RATE_LIMIT_MAX, 10) || RATE_LIMIT_DEFAULT;
  if (isRateLimitBypassed(env, ip)) {
    return { allowed: true, remaining: max, resetIn: 0, enforced: false, bypassed: true };
  }
  if (!env.RATE_LIMIT_KV || !ip) return { allowed: true, remaining: max, resetIn: 0, enforced: false };
  const key = `rl:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    let rec = raw ? JSON.parse(raw) : null;
    if (!rec || now >= rec.resetAt) {
      rec = { count: 0, resetAt: now + RATE_WINDOW_SEC };
    }
    if (rec.count >= max) {
      return { allowed: false, remaining: 0, resetIn: rec.resetAt - now, enforced: true };
    }
    rec.count += 1;
    // expire the key automatically at window end
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(rec), { expirationTtl: rec.resetAt - now });
    return { allowed: true, remaining: max - rec.count, resetIn: rec.resetAt - now, enforced: true };
  } catch {
    return { allowed: true, remaining: max, resetIn: 0, enforced: false };
  }
}

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    return new URL(u).toString();
  } catch {
    return "";
  }
}

async function tryFetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "th,en;q=0.9" },
      redirect: "follow",
      signal: ctrl.signal,
      cf: { cacheTtl: 0 },
    });
    const body = await r.text();
    return { status: r.status, ok: r.ok, body, finalUrl: r.url,
             headers: Object.fromEntries(r.headers) };
  } catch (e) {
    return { status: 0, ok: false, body: "", error: String(e), finalUrl: url, headers: {} };
  } finally {
    clearTimeout(t);
  }
}

// Light, dependency-free extraction from raw HTML.
function extractFacts(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : "";
  };
  const metaName = (n) =>
    pick(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${n}["']`, "i"));
  const metaProp = (p) =>
    pick(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${p}["']`, "i"));

  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim()
  );
  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
  const lang = pick(/<html[^>]+lang=["']([^"']*)["']/i);
  const viewport = metaName("viewport");
  const jsonLdBlocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )].map((m) => m[1]);
  const schemaTypes = [...new Set(
    jsonLdBlocks.flatMap((b) => [...b.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((x) => x[1]))
  )];
  const imgCount = (html.match(/<img\b/gi) || []).length;
  const imgNoAlt = (html.match(/<img\b(?:(?!alt=)[^>])*>/gi) || []).length;
  const textOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title,
    h1: h1s,
    metaDescription: metaName("description"),
    canonical,
    lang,
    viewport,
    og: {
      title: metaProp("og:title"),
      description: metaProp("og:description"),
      image: metaProp("og:image"),
      url: metaProp("og:url"),
      type: metaProp("og:type"),
      site_name: metaProp("og:site_name"),
      locale: metaProp("og:locale"),
    },
    twitterCard: metaName("twitter:card"),
    schemaTypes,
    hasJsonLd: jsonLdBlocks.length > 0,
    imgCount,
    imgMissingAlt: imgNoAlt,
    approxWordCount: textOnly ? textOnly.split(" ").length : 0,
    textSample: textOnly.slice(0, 2500),
  };
}

function botVerdict(robotsBody) {
  // crude per-agent allow check for the agents that matter
  const agents = ["GPTBot", "ClaudeBot", "PerplexityBot", "OAI-SearchBot",
                  "Google-Extended", "Googlebot", "Bingbot"];
  const out = {};
  for (const a of agents) {
    const block = new RegExp(`User-agent:\\s*${a}[\\s\\S]*?(?=User-agent:|$)`, "i");
    const m = robotsBody.match(block);
    out[a] = m && /Disallow:\s*\/\s*$/im.test(m[0]) ? "blocked" : "allowed";
  }
  return out;
}

const SYSTEM_PROMPT = `You are a senior technical-SEO, GEO/AEO (AI-search) and social-visibility auditor working to 2026 standards. You receive raw signals extracted from a live website and must return a rigorous, honest audit.

Scoring model (weights): AI Crawler Access 25%, AI Search/GEO-AEO 25%, Technical SEO 22%, Social/Open Graph 16%, Performance 12%. Being CITED by AI answer engines (ChatGPT, Claude, Perplexity, Gemini) is the new #1 position.

You MUST respond with ONLY a JSON object (no markdown, no prose, no code fences) matching exactly this schema:
{
 "url": string,
 "overall": integer 0-100,
 "grade": "A"|"B"|"C"|"D"|"F",
 "summary": string (2-3 sentences, in BOTH Thai and English separated by " // "),
 "categories": [
   {"name": string, "score": integer 0-100, "grade": "A"|"B"|"C"|"D"|"F",
    "findings": [
      {"check": string, "status": "pass"|"warn"|"fail"|"info",
       "severity": "critical"|"high"|"medium"|"low",
       "detail": string, "fix": string}
    ]}
 ],
 "footprint": {"summary": string, "items": [{"label": string, "value": string, "state": "good"|"warn"|"bad"|"info"}], "notes": [string]}
}
Use these four category names exactly: "Technical SEO (Google 2026)", "AI Search / GEO-AEO", "AI Crawler Access", "Social Sharing & Open Graph".
Grade bands: A>=90, B>=80, C>=70, D>=55, else F. Compute each category score by deducting from 100 per failed/warned finding weighted by severity (critical 30, high 18, medium 9, low 4; warn = half). Overall = weighted blend above. Be specific and actionable in every "fix". If a signal could not be fetched, say so honestly rather than inventing data. If "coreWebVitals" is present, add specific findings to the "Technical SEO (Google 2026)" category for LCP (good <2500ms), INP (good <200ms) and CLS (good <0.1), since Core Web Vitals are a confirmed Google ranking signal.`;

function extractJson(text) {
  // strip code fences if any, then grab the outermost {...}
  let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callClaude(env, messages, maxTokens = 8000) {
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || DEFAULT_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
  } catch (e) {
    return { ok: false, error: "Could not reach the Claude API: " + String(e), status: 502 };
  }

  if (!resp.ok) {
    const errText = await resp.text();
    return { ok: false, error: "Claude API error " + resp.status, detail: errText.slice(0, 500), status: 502 };
  }

  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { ok: true, text, stopReason: data.stop_reason || null };
}

/**
 * PageSpeed Insights — real Core Web Vitals (mobile). Prefers field data
 * (CrUX real users); falls back to lab. Optional GOOGLE_PSI_KEY raises quota.
 * Returns null on any failure/timeout so the scan still completes.
 */
async function fetchPSI(targetUrl, env, timeoutMs = 22000) {
  const key = env.GOOGLE_PSI_KEY ? `&key=${env.GOOGLE_PSI_KEY}` : "";
  const api =
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile" +
    "&category=performance&url=" + encodeURIComponent(targetUrl) + key;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(api, { signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    const lab = d.lighthouseResult || {};
    const audits = lab.audits || {};
    const field = (d.loadingExperience && d.loadingExperience.metrics) || {};
    const fc = (m) => (field[m] ? { value: field[m].percentile, rating: field[m].category } : null);
    return {
      source: Object.keys(field).length ? "field (CrUX real users)" : "lab (Lighthouse)",
      performanceScore: lab.categories?.performance ? Math.round(lab.categories.performance.score * 100) : null,
      lcp: fc("LARGEST_CONTENTFUL_PAINT_MS") ||
        (audits["largest-contentful-paint"] ? { value: Math.round(audits["largest-contentful-paint"].numericValue), rating: null } : null),
      inp: fc("INTERACTION_TO_NEXT_PAINT") ||
        (audits["interaction-to-next-paint"] ? { value: Math.round(audits["interaction-to-next-paint"].numericValue), rating: null } : null),
      cls: (field.CUMULATIVE_LAYOUT_SHIFT_SCORE
              ? { value: Math.round(field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile) / 100,
                  rating: field.CUMULATIVE_LAYOUT_SHIFT_SCORE.category }
              : (audits["cumulative-layout-shift"]
                  ? { value: Math.round(audits["cumulative-layout-shift"].numericValue * 100) / 100, rating: null }
                  : null)),
      ttfb: fc("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in the Cloudflare Pages project settings." }, 500);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const rl = await checkRateLimit(env, ip);
  if (!rl.allowed) {
    const mins = Math.ceil(rl.resetIn / 60);
    return json(
      { error: `Rate limit reached. Try again in about ${mins} minute(s). // ถึงขีดจำกัดแล้ว ลองใหม่ในอีกประมาณ ${mins} นาที`,
        retryIn: rl.resetIn },
      429,
      { "Retry-After": String(rl.resetIn) }
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const url = normalizeUrl(payload.url);
  const userPrompt = (payload.prompt || "").toString().slice(0, 2000);
  if (!url) return json({ error: "Please provide a valid website URL." }, 400);

  const root = new URL(url).origin;
  const [home, robots, sitemap, llms, psi] = await Promise.all([
    tryFetchText(url),
    tryFetchText(root + "/robots.txt"),
    tryFetchText(root + "/sitemap.xml"),
    tryFetchText(root + "/llms.txt"),
    fetchPSI(url, env),
  ]);

  const facts = {
    requestedUrl: url,
    fetch: {
      home: { status: home.status, ok: home.ok, finalUrl: home.finalUrl, error: home.error || null },
      robots: { status: robots.status, present: robots.ok && /(allow|disallow|user-agent)/i.test(robots.body) },
      sitemap: { status: sitemap.status, present: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body) },
      llms: { status: llms.status, present: llms.ok && llms.body.trim().length > 0 },
    },
    page: home.ok ? extractFacts(home.body) : null,
    coreWebVitals: psi,
    robotsTxt: robots.ok ? robots.body.slice(0, 3000) : "",
    botPolicy: robots.ok ? botVerdict(robots.body) : null,
  };

  const userBlock =
    `Audit this website. Signals follow as JSON.\n\n` +
    (userPrompt ? `User focus / instructions: ${userPrompt}\n\n` : "") +
    `SIGNALS:\n${JSON.stringify(facts, null, 2)}`;

  const first = await callClaude(env, [{ role: "user", content: userBlock }], 8000);
  if (!first.ok) {
    return json(first.detail ? { error: first.error, detail: first.detail } : { error: first.error }, first.status || 502);
  }

  let scan;
  try {
    scan = extractJson(first.text);
  } catch {
    // Claude can occasionally run out of tokens or emit prose around JSON. Retry once
    // with a compact repair/audit instruction so the UI does not fail on valid scans.
    const repairPrompt =
      `Return ONLY one complete valid JSON object for this scan. No markdown, no prose. ` +
      `Keep it compact: exactly four categories, 2-3 findings per category max. ` +
      `Use the required schema from the system prompt.\n\n` +
      `Signals JSON:\n${JSON.stringify(facts, null, 2)}\n\n` +
      `User focus: ${userPrompt || "General visibility audit"}\n\n` +
      `Previous invalid/truncated model output to repair if useful:\n${first.text.slice(0, 5000)}`;
    const second = await callClaude(env, [{ role: "user", content: repairPrompt }], 8000);
    if (!second.ok) {
      return json(second.detail ? { error: second.error, detail: second.detail } : { error: second.error }, second.status || 502);
    }
    try {
      scan = extractJson(second.text);
    } catch {
      return json({ error: "Model did not return valid JSON after retry.", raw: second.text.slice(0, 800) }, 502);
    }
  }

  scan.url = scan.url || url;
  scan.scanned_at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  scan._fetch = facts.fetch; // expose raw fetch status to the UI
  scan._cwv = psi;           // raw Core Web Vitals for the metrics strip
  scan._rateRemaining = rl.remaining;
  return json(scan);
}
