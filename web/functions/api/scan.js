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

import { callLLM } from "./_llm.js";
import { requireSession } from "./_auth.js";
import { dbReady, ensureOrgForSession, ensureSite, getSite, recordAudit, recordFindings, recordRecommendations, recordAlert } from "./_db.js";
import { signedFetch } from "./_botauth.js";
import { aimarkBotAccess, isOptedOut } from "./_botpolicy.js";

const SEVERITY_PRIORITY = { critical: 1, high: 2, medium: 3, low: 4, info: 5 };

/**
 * Platform Phase 1: persist a relational audit row for SIGNED-IN users so the
 * scanner accrues per-site history (the Visibility Score time-series). Anonymous
 * scans stay ephemeral (the funnel). Best-effort — never affects the scan response.
 */
async function persistScanAudit(context, url, det) {
  try {
    const { request, env } = context;
    if (!dbReady(env)) return;
    const session = await requireSession(request, env);
    if (!session || !session.email) return;
    const ctx = await ensureOrgForSession(env, session);
    if (!ctx) return;
    const siteId = await ensureSite(env, ctx.org_id, url);
    if (!siteId) return;
    // Capture the prior score BEFORE recording the new audit (alert engine input).
    const prevSite = await getSite(env, ctx.org_id, siteId);
    const prevScore = (prevSite && prevSite.latest_score != null) ? Number(prevSite.latest_score) : null;
    const auditId = await recordAudit(env, {
      orgId: ctx.org_id, siteId, kind: "visibility",
      overall: det.overall, scores: det.categories,
      engineVersion: "det-rubric-v1", trigger: context._monitor ? "scheduled" : "manual",
    });
    // Alert engine: a real score drop is the reason customers come back (recurring value).
    const newScore = (det.overall == null) ? null : Math.round(det.overall);
    const dropThreshold = Number(env.AIMARK_ALERT_DROP_THRESHOLD || 5);
    if (prevScore != null && newScore != null && (prevScore - newScore) >= dropThreshold) {
      const drop = prevScore - newScore;
      await recordAlert(env, { orgId: ctx.org_id, siteId, type: "score_drop", severity: drop >= 15 ? "high" : "medium", message: `Visibility dropped ${drop} pts (${prevScore} to ${newScore}) on ${hostOf(url)}` });
    }
    const fails = (det.checks || []).filter((c) => String(c.status || "").toLowerCase() === "fail");
    const findings = fails.map((c) => ({ category: c.category, severity: c.severity || "medium", code: c.check, title: c.check, detail: c.detail || "" }));
    await recordFindings(env, { orgId: ctx.org_id, siteId, auditId, findings });
    // Actionable Intelligence: prioritized recommendations (critical/high first).
    const CHECK_TITLES = {
      "Depth for AI citation (>=600 words)": "Add depth — expand content to 600+ words",
      "Baseline content (>=300 words)": "Add more content — page needs 300+ words",
      "Substantive content (>=400 words)": "Expand page content to 400+ words",
      "Crawlable content present": "Add readable content for crawlers",
      "FAQ / question-style content": "Add FAQ section with real buyer questions",
      "Schema types present": "Add structured data (JSON-LD schema)",
      "Answer/entity schema (FAQ/Article/LocalBusiness)": "Add FAQ/LocalBusiness/Article schema",
      "Freshness signal": "Add a freshness date or 'Updated' signal",
      "Shareable description": "Add og:description for social sharing",
      "Title tag": "Fix or add the page title tag",
      "Meta description": "Write a 140-160 char meta description",
      "H1 heading": "Add a main H1 heading",
      "Canonical URL": "Set a canonical URL",
      "Structured data (JSON-LD)": "Add JSON-LD structured data",
      "Image alt text": "Add alt text to images",
      "Mobile viewport": "Add mobile viewport meta tag",
      "robots.txt present": "Create a robots.txt file",
      "Sitemap present": "Create and submit a sitemap.xml",
      "llms.txt present": "Add llms.txt for AI crawlers",
      "AI/search bots not blocked": "Unblock AI and search crawlers in robots.txt",
      "og:title": "Add og:title for social sharing",
      "og:description": "Add og:description for social sharing",
      "og:image": "Add og:image for social sharing",
      "Twitter card": "Add Twitter card meta tags",
      "HTTPS": "Switch to HTTPS",
    };
    const EFFORT_BY_SEVERITY = { critical: "medium", high: "medium", medium: "low", low: "low", info: "low" };
    const IMPACT_BY_SEVERITY = {
      critical: "High impact on AI citations and discoverability",
      high: "Significant impact on search and AI visibility",
      medium: "Moderate impact on rankings and trust",
      low: "Small improvement to signals and completeness",
      info: "Informational — verify when possible",
    };
    const recs = fails
      .map((c) => {
        const sev = String(c.severity || "medium").toLowerCase();
        const humanTitle = CHECK_TITLES[c.check] || c.check;
        const detailSuffix = c.detail ? ` (${c.detail})` : "";
        const impact = IMPACT_BY_SEVERITY[sev] || "Improves visibility signals";
        return {
          priority: SEVERITY_PRIORITY[sev] || 3,
          title: humanTitle,
          action: c.fix || "",
          impact: impact + detailSuffix,
          effort: EFFORT_BY_SEVERITY[sev] || "low",
        };
      })
      .sort((a, b) => a.priority - b.priority).slice(0, 30);
    await recordRecommendations(env, { orgId: ctx.org_id, siteId, auditId, recs });
  } catch { /* best-effort; the scan must never fail because of persistence */ }
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const RATE_WINDOW_SEC = 3600;          // 1 hour
const RATE_LIMIT_DEFAULT = 5;          // scans per IP per window
const PSI_CACHE_TTL_SEC = 24 * 60 * 60; // 24 hours per URL to avoid quota burn
const PSI_ERROR_CACHE_TTL_SEC = 10 * 60; // short backoff for quota/timeout errors
const AIMARK_UA = "AIBotAuth/1.0 (+https://aibotauth.com/bot; site-owner-requested audit)";

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
  // Fail-CLOSED: no KV binding = deny, not allow (never spend LLM tokens ungated)
  if (!env.RATE_LIMIT_KV || !ip) return { allowed: false, remaining: 0, resetIn: 60, enforced: false, reason: "kv_unbound" };
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

async function tryFetchText(env, url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await signedFetch(env, url, {
      headers: { "User-Agent": AIMARK_UA, "Accept-Language": "th,en;q=0.9" },
      redirect: "follow",
      signal: ctrl.signal,
      cf: { cacheTtl: 0 },
    });
    const body = await r.text();
    return { status: r.status, ok: r.ok, body, finalUrl: r.url,
             headers: Object.fromEntries(r.headers), fetchMs: Date.now() - started };
  } catch (e) {
    return { status: 0, ok: false, body: "", error: String(e), finalUrl: url, headers: {}, fetchMs: Date.now() - started };
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

function getSitemapUrls(sitemapBody) {
  return [...String(sitemapBody || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .slice(0, 200);
}

function countMatches(text, regex) {
  return (String(text || "").match(regex) || []).length;
}

function headerValue(headers = {}, name = "") {
  const direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (direct != null) return String(direct);
  const found = Object.keys(headers || {}).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? String(headers[found]) : "";
}

function buildPerformanceLite(home) {
  const html = String(home?.body || "");
  const headers = home?.headers || {};
  const htmlBytes = new TextEncoder().encode(html).length;
  const htmlKb = Math.round(htmlBytes / 10.24) / 100;
  const fetchMs = Number(home?.fetchMs || 0);
  const compression = headerValue(headers, "content-encoding");
  const cacheControl = headerValue(headers, "cache-control");
  const contentType = headerValue(headers, "content-type");
  const resourceHints = countMatches(html, /<link[^>]+rel=["'](?:preconnect|dns-prefetch|preload|modulepreload)["']/gi);
  const scriptCount = countMatches(html, /<script\b/gi);
  const stylesheetCount = countMatches(html, /<link[^>]+rel=["']stylesheet["']/gi);
  const imageCount = countMatches(html, /<img\b/gi);
  let score = home?.ok ? 100 : 0;
  if (fetchMs > 5000) score -= 30;
  else if (fetchMs > 2500) score -= 18;
  else if (fetchMs > 1200) score -= 8;
  if (htmlBytes > 500_000) score -= 15;
  else if (htmlBytes > 200_000) score -= 8;
  if (!compression && htmlBytes > 60_000) score -= 8;
  if (scriptCount > 40) score -= 10;
  else if (scriptCount > 20) score -= 5;
  if (stylesheetCount > 15) score -= 5;
  if (imageCount > 50) score -= 6;
  if (resourceHints === 0 && (scriptCount > 12 || stylesheetCount > 6)) score -= 4;
  return {
    source: "AI Mark public fetch performance-lite",
    verified_core_web_vitals: false,
    available: !!home?.ok,
    score: clamp(score),
    html_fetch_ms: fetchMs || null,
    html_kb: htmlKb,
    html_bytes: htmlBytes,
    compression: compression || "",
    cache_control: cacheControl || "",
    content_type: contentType || "",
    resource_hints: resourceHints,
    script_count: scriptCount,
    stylesheet_count: stylesheetCount,
    image_count: imageCount,
    note: "This is low-resource public fetch evidence, not Lighthouse or Core Web Vitals. It keeps the scan useful when PSI quota is unavailable.",
  };
}

function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return ""; }
}

function exactHostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); }
  catch { return ""; }
}

function oppositeWwwUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
    else u.hostname = "www." + u.hostname;
    u.pathname = "/";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch { return ""; }
}

function migrationSignals(requestedUrl, finalUrl, page, robotsBody, sitemapBody, alternateHome) {
  const canonical = page?.canonical || "";
  const ogUrl = page?.og?.url || "";
  const sitemapUrls = getSitemapUrls(sitemapBody);
  const finalExact = exactHostOf(finalUrl || requestedUrl);
  const canonicalExact = exactHostOf(canonical);
  const ogExact = exactHostOf(ogUrl);
  const sitemapExactHosts = [...new Set(sitemapUrls.map(exactHostOf).filter(Boolean))];
  const requestedBare = hostOf(requestedUrl);
  const canonicalBare = hostOf(canonical);
  const altFinalExact = exactHostOf(alternateHome?.finalUrl || "");
  const altStatus = alternateHome?.status || 0;
  const alternateServes200 = !!(alternateHome && alternateHome.ok && altFinalExact && altFinalExact !== finalExact);
  const canonicalHostMismatch = !!(canonicalExact && finalExact && canonicalExact !== finalExact);
  const ogHostMismatch = !!(ogExact && finalExact && ogExact !== finalExact);
  const sitemapHostMismatch = sitemapExactHosts.length > 0 && (!sitemapExactHosts.includes(finalExact) || sitemapExactHosts.some((h) => h !== finalExact));
  const bareDomainSame = !!(requestedBare && canonicalBare && requestedBare === canonicalBare);
  return {
    requestedUrl,
    finalUrl,
    finalHost: finalExact,
    canonical,
    canonicalHost: canonicalExact,
    canonicalHostMismatch,
    ogUrl,
    ogHost: ogExact,
    ogHostMismatch,
    robotsSitemapLines: [...String(robotsBody || "").matchAll(/^\s*Sitemap:\s*(.+)$/gim)].map((m) => m[1].trim()),
    sitemapUrlCount: sitemapUrls.length,
    sitemapSampleUrls: sitemapUrls.slice(0, 12),
    sitemapHosts: sitemapExactHosts,
    sitemapHostMismatch,
    alternateHostUrl: oppositeWwwUrl(requestedUrl),
    alternateHostStatus: altStatus,
    alternateHostFinalUrl: alternateHome?.finalUrl || "",
    alternateHostServes200WithoutRedirectToFinalHost: alternateServes200,
    duplicateHostRisk: alternateServes200 || canonicalHostMismatch || sitemapHostMismatch,
    sameBareDomainButWwwSplit: bareDomainSame && (canonicalHostMismatch || alternateServes200 || sitemapHostMismatch),
    indexCoverageWarning: sitemapUrls.length <= 3
      ? "Sitemap has only a few URLs. Public search may only know the homepage and may keep older snippets until Google recrawls. Verify URL Inspection / Coverage in Google Search Console."
      : "Sitemap has multiple URLs, but true Google index status still requires Google Search Console URL Inspection or an authorized indexing API/source.",
  };
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
Grade bands: A>=90, B>=80, C>=70, D>=55, else F. Compute each category score by deducting from 100 per failed/warned finding weighted by severity (critical 30, high 18, medium 9, low 4; warn = half). Overall = weighted blend above. Be specific and actionable in every "fix". If a signal could not be fetched, say so honestly rather than inventing data. If "coreWebVitals" is present, add specific findings to the "Technical SEO (Google 2026)" category for LCP (good <2500ms), INP (good <200ms) and CLS (good <0.1), since Core Web Vitals are a confirmed Google ranking signal.

Migration/index rigor rules:
- Treat "migration" signals as first-class Google visibility evidence, not minor metadata. If alternate www/non-www hosts both return 200 without redirecting to the selected final host, or canonical/OG/sitemap hosts disagree with the served final host, mark this as HIGH or CRITICAL because Google may split signals, keep older indexed snippets, or index only the wrong host.
- If sitemapUrlCount is very low (<=3), warn that index coverage is thin and the scan cannot prove Google has indexed all key pages. Recommend Google Search Console URL Inspection + sitemap resubmission + internal links/backlinks.
- Never claim "Google index is healthy" unless authorized Search Console/index evidence is present. Public signals can only say "indexability looks OK" or "public search evidence suggests only limited/old coverage".
- If the user prompt mentions index, old site, migration, or Google, include an explicit finding named "Google index / migration coverage" in Technical SEO.`;

function extractJson(text) {
  // strip code fences if any, then grab the outermost {...}
  let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callClaude(env, messages, maxTokens = 8000) {
  // Delegates to the shared multi-provider caller (Anthropic → Groq → Kimi).
  const r = await callLLM(env, { system: SYSTEM_PROMPT, messages, maxTokens, temperature: 0 });
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail, status: r.status || 502 };
  return { ok: true, text: r.text, provider: r.provider };
}

function shortHash(input) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

function pageSpeedCacheKv(env) {
  return env.PROOF_KV || env.RATE_LIMIT_KV || env.ENTITLEMENTS_KV || null;
}

function pageSpeedCacheKey(targetUrl) {
  return `psi:v2:${shortHash(targetUrl)}`;
}

async function readCachedPSI(targetUrl, env) {
  const kv = pageSpeedCacheKv(env);
  if (!kv) return null;
  try {
    const rec = await kv.get(pageSpeedCacheKey(targetUrl), "json");
    if (!rec || !rec.result) return null;
    return {
      ...rec.result,
      cached: true,
      cache_status: "hit",
      cached_at: rec.cached_at || null,
      cache_ttl_seconds: rec.cache_ttl_seconds || null,
    };
  } catch {
    return null;
  }
}

async function writeCachedPSI(targetUrl, env, result) {
  const kv = pageSpeedCacheKv(env);
  if (!kv || !result) return false;
  const hasScore = result.performanceScore != null;
  const ttl = hasScore ? PSI_CACHE_TTL_SEC : PSI_ERROR_CACHE_TTL_SEC;
  try {
    await kv.put(pageSpeedCacheKey(targetUrl), JSON.stringify({
      cached_at: new Date().toISOString(),
      cache_ttl_seconds: ttl,
      result: { ...result, cached: false, cache_status: "miss" },
    }), { expirationTtl: ttl });
    return true;
  } catch {
    return false;
  }
}

/**
 * PageSpeed Insights — real Core Web Vitals (mobile). Prefers field data
 * (CrUX real users); falls back to lab. Optional GOOGLE_PSI_KEY raises quota.
 * Returns null on any failure/timeout so the scan still completes.
 */
async function fetchPSI(targetUrl, env, timeoutMs = 22000) {
  const cached = await readCachedPSI(targetUrl, env);
  if (cached) return cached;
  const cacheAvailable = !!pageSpeedCacheKv(env);
  const key = env.GOOGLE_PSI_KEY ? `&key=${env.GOOGLE_PSI_KEY}` : "";
  const api =
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile" +
    "&category=performance&url=" + encodeURIComponent(targetUrl) + key;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(api, { signal: ctrl.signal });
    if (!r.ok) {
      let message = `PageSpeed Insights HTTP ${r.status}`;
      try {
        const err = await r.json();
        message = err?.error?.message || message;
      } catch {}
      const result = {
        source: "PageSpeed Insights",
        performanceScore: null,
        error: message,
        status: r.status,
        cached: false,
        cache_status: cacheAvailable ? "miss" : "disabled",
        cache_ttl_seconds: cacheAvailable ? PSI_ERROR_CACHE_TTL_SEC : null,
      };
      await writeCachedPSI(targetUrl, env, result);
      return result;
    }
    const d = await r.json();
    const lab = d.lighthouseResult || {};
    const audits = lab.audits || {};
    const field = (d.loadingExperience && d.loadingExperience.metrics) || {};
    const fc = (m) => (field[m] ? { value: field[m].percentile, rating: field[m].category } : null);
    const result = {
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
      cached: false,
      cache_status: cacheAvailable ? "miss" : "disabled",
      cache_ttl_seconds: cacheAvailable ? PSI_CACHE_TTL_SEC : null,
    };
    await writeCachedPSI(targetUrl, env, result);
    return result;
  } catch (err) {
    const result = {
      source: "PageSpeed Insights",
      performanceScore: null,
      error: String(err?.name || err?.message || "PageSpeed request failed"),
      status: 0,
      cached: false,
      cache_status: cacheAvailable ? "miss" : "disabled",
      cache_ttl_seconds: cacheAvailable ? PSI_ERROR_CACHE_TTL_SEC : null,
    };
    await writeCachedPSI(targetUrl, env, result);
    return result;
  } finally {
    clearTimeout(t);
  }
}

/**
 * DETERMINISTIC scoring — the numeric score must NOT depend on which LLM runs.
 * Computed from the extracted signals so the same site always scores the same
 * (stable before/after proof). The LLM only explains the findings.
 */
function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }
function computeScores(facts) {
  const p = facts.page || {}; const f = facts.fetch || {}; const og = p.og || {};
  const wc = p.approxWordCount || 0; const sample = p.textSample || "";
  const bots = facts.botPolicy || {};
  const blocked = Object.entries(bots).filter(([, v]) => v === "blocked").map(([k]) => k);
  const TECH = "Technical SEO (Google 2026)", AI = "AI Search / GEO-AEO", CR = "AI Crawler Access", SO = "Social Sharing & Open Graph", PERF = "Performance / Core Web Vitals";
  const C = [];
  const add = (category, check, ok, severity, w, detail, status) =>
    C.push({ category, check, ok, severity, w, detail: detail || "", status });
  add(TECH, "HTTPS", /^https:/i.test(facts.requestedUrl || ""), "high", 12);
  add(TECH, "Title tag", !!(p.title && p.title.length >= 10 && p.title.length <= 70), "high", 12, p.title ? `length ${p.title.length}` : "missing");
  add(TECH, "Meta description", !!(p.metaDescription && p.metaDescription.length >= 80), "medium", 10, p.metaDescription ? `length ${p.metaDescription.length}` : "missing");
  add(TECH, "Mobile viewport", !!p.viewport, "medium", 6);
  add(TECH, "H1 heading", (p.h1 || []).length >= 1, "medium", 8);
  add(TECH, "Canonical URL", !!p.canonical, "low", 6);
  add(TECH, "Structured data (JSON-LD)", !!p.hasJsonLd, "high", 12);
  add(TECH, "Image alt text", p.imgCount === 0 || ((p.imgCount - (p.imgMissingAlt || 0)) / Math.max(p.imgCount, 1)) >= 0.7, "low", 6);
  add(TECH, "Substantive content (>=400 words)", wc >= 400, "critical", 18, `~${wc} words`);
  add(AI, "Depth for AI citation (>=600 words)", wc >= 600, "critical", 22, `~${wc} words`);
  add(AI, "FAQ / question-style content", /faq|frequently asked|คำถาม|ถามบ่อย|how to|what is|why /i.test(sample), "high", 16);
  add(AI, "Schema types present", (p.schemaTypes || []).length > 0, "high", 16, (p.schemaTypes || []).join(", "));
  add(AI, "Answer/entity schema (FAQ/Article/LocalBusiness)", (p.schemaTypes || []).some((t) => /FAQ|HowTo|Article|Product|Service|LocalBusiness|Organization/i.test(t)), "medium", 12);
  add(AI, "Freshness signal", /20(2[4-9]|[3-9]\d)|updated|ล่าสุด/i.test(sample), "low", 10);
  add(AI, "Baseline content (>=300 words)", wc >= 300, "high", 12, `~${wc} words`);
  add(AI, "Shareable description", !!og.description, "low", 12);
  add(CR, "robots.txt present", !!(f.robots && f.robots.present), "high", 22);
  add(CR, "Sitemap present", !!(f.sitemap && f.sitemap.present), "high", 24);
  add(CR, "llms.txt present", !!(f.llms && f.llms.present), "low", 14);
  add(CR, "AI/search bots not blocked", blocked.length === 0, "critical", 28, blocked.length ? `blocked: ${blocked.join(", ")}` : "none blocked");
  add(CR, "Crawlable content present", wc >= 200, "medium", 12, `~${wc} words`);
  add(SO, "og:title", !!og.title, "high", 26);
  add(SO, "og:description", !!og.description, "medium", 24);
  add(SO, "og:image", !!og.image, "high", 28);
  add(SO, "Twitter card", !!p.twitterCard, "medium", 22);
  const cwv = facts.coreWebVitals;
  const perfVerified = !!(cwv && cwv.performanceScore != null);
  add(PERF, "PageSpeed / Core Web Vitals verified", perfVerified, "info", 0, perfVerified ? `${cwv.performanceScore}/100` : (cwv?.error || "PageSpeed unavailable"), perfVerified ? "pass" : "unverified");
  const catScore = (cat) => { const arr = C.filter((c) => c.category === cat); const max = arr.reduce((a, c) => a + c.w, 0) || 1; const got = arr.filter((c) => c.ok).reduce((a, c) => a + c.w, 0); return clamp(got * 100 / max); };
  const technical = catScore(TECH), ai = catScore(AI), crawler = catScore(CR), social = catScore(SO);
  const perf = perfVerified ? clamp(cwv.performanceScore) : null;
  const effectivePerf = perfVerified ? perf : 0;
  const parts = [[crawler, 25], [ai, 25], [technical, 22], [social, 16], [effectivePerf, 12]];
  const wsum = 100;
  const overall = clamp(parts.reduce((a, x) => a + x[0] * x[1], 0) / wsum);
  const grade = overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 55 ? "D" : "F";
  return {
    overall,
    grade,
    categories: { [TECH]: technical, [AI]: ai, [CR]: crawler, [SO]: social },
    performance: perf,
    performanceVerified: perfVerified,
    checks: C.map((c) => ({ category: c.category, check: c.check, status: c.status || (c.ok ? "pass" : "fail"), severity: c.severity, detail: c.detail })),
  };
}

function gradeFor(score) {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 55 ? "D" : "F";
}

function fallbackFix(check, lang) {
  const th = lang === "th";
  if (/title/i.test(check)) return th ? "เขียน title ให้สั้น ชัด มีชื่อแบรนด์และคำค้นหลักของบริการ" : "Write a concise title with the brand and primary service keyword.";
  if (/meta description/i.test(check)) return th ? "เพิ่ม meta description 140-160 ตัวอักษรที่บอกประโยชน์ พื้นที่บริการ และ CTA" : "Add a 140-160 character meta description with benefit, service area, and CTA.";
  if (/canonical/i.test(check)) return th ? "ตั้ง canonical ให้ชี้ URL หลักที่ต้องการให้ Google index เพียงเวอร์ชันเดียว" : "Set the canonical URL to the single version Google should index.";
  if (/Structured data|Schema/i.test(check)) return th ? "เพิ่ม JSON-LD Organization/LocalBusiness/FAQPage ให้ตรงกับธุรกิจจริง" : "Add JSON-LD Organization/LocalBusiness/FAQPage schema grounded in the real business.";
  if (/FAQ|question/i.test(check)) return th ? "เพิ่ม FAQ ที่ตอบคำถามลูกค้าจริงแบบสั้น ชัด และแสดงบนหน้าเว็บ" : "Add visible answer-led FAQ content for real buyer questions.";
  if (/robots/i.test(check)) return th ? "สร้างหรือแก้ robots.txt ให้ crawler สำคัญและ AI bots อ่านหน้า public ได้" : "Create or update robots.txt so search crawlers and AI bots can access public pages.";
  if (/Sitemap/i.test(check)) return th ? "สร้าง sitemap.xml และอ้างใน robots.txt เพื่อให้ Google เจอหน้าสำคัญครบ" : "Create sitemap.xml and reference it in robots.txt so Google finds key pages.";
  if (/llms/i.test(check)) return th ? "เพิ่ม llms.txt ที่สรุปบริการ หน้าเด่น และช่องทางติดต่อสำหรับ AI crawler" : "Add llms.txt summarizing services, key pages, and contact paths for AI crawlers.";
  if (/og:image|Open Graph|og:/i.test(check)) return th ? "เพิ่ม Open Graph title/description/image ให้แชร์แล้วดูน่าเชื่อถือและคลิกง่าย" : "Add Open Graph title, description, and image for stronger social previews.";
  if (/content|words|citation/i.test(check)) return th ? "เพิ่มเนื้อหาหน้าบริการให้ตอบ ใคร/ทำอะไร/เหมาะกับใคร/ราคาเริ่มต้น/ติดต่ออย่างไร" : "Add service-page content that answers who it helps, what it does, proof, pricing cues, and contact path.";
  if (/PageSpeed|Core Web Vitals/i.test(check)) return th ? "รอระบบวัด PageSpeed สำเร็จ หรือใช้ GA4/Search Console/CrUX ตรวจซ้ำ ไม่ใช่จุดแก้เว็บจนกว่าจะมี metric จริง" : "Wait for PageSpeed verification or validate with GA4/Search Console/CrUX; this is not a site fix until real metrics are available.";
  return th ? "ตรวจจุดนี้ใน CMS หรือ repo แล้วแก้ให้ข้อมูล public อ่านได้ชัดสำหรับ Google และ AI" : "Inspect this in the CMS or repo and make the public signal clearer for Google and AI.";
}

function buildDeterministicScan(url, facts, det, lang, reason = "") {
  const th = lang === "th";
  const agentFirstReason = reason === "agent_first_local_runner";
  const categoryNames = Object.keys(det.categories);
  const categories = categoryNames.map((name) => {
    const score = det.categories[name];
    const findings = det.checks
      .filter((c) => c.category === name)
      .map((c) => ({
        check: c.check,
        status: c.status,
        severity: c.severity,
        detail: c.detail || (c.status === "pass" ? (th ? "ผ่านจากสัญญาณที่ตรวจได้" : "Passed based on detected public signals.") : ""),
        fix: ["fail", "warn"].includes(String(c.status || "").toLowerCase()) ? fallbackFix(c.check, lang) : "",
      }));
    return { name, score, grade: gradeFor(score), findings };
  });
  const fixable = det.checks.filter((c) => ["fail", "warn"].includes(String(c.status || "").toLowerCase()));
  const unverified = det.checks.filter((c) => String(c.status || "").toLowerCase() === "unverified");
  const perfNote = det.performanceVerified
    ? ""
    : (th
      ? " Performance ยังไม่ได้ verify จึงกันคะแนน 12% ไว้ก่อนและไม่อนุญาตให้คะแนนเต็ม 100"
      : " Performance is not verified, so the 12% performance weight is held back and the score cannot be 100.");
  const verificationNote = unverified.length
    ? (th ? ` มีข้อมูลที่ต้องตรวจเพิ่ม ${unverified.length} จุด` : ` ${unverified.length} item(s) need verification`)
    : "";
  const verification = {
    score_status: det.performanceVerified ? "verified" : "provisional",
    missing_evidence: unverified.map((c) => ({
      category: c.category,
      check: c.check,
      detail: c.detail || "",
    })),
    cannot_infer_from_public_scan: [
      "traffic_source_attribution",
      "GA4_sessions",
      "Google_Search_Console_clicks_queries",
      "ad_spend_or_CAC",
      "actual_AI_citations_without_live_probe",
    ],
    score_guardrail: det.performanceVerified
      ? "All weighted score components used by the deterministic rubric were available."
      : "Performance/Core Web Vitals could not be verified, so the 12% performance weight is held at zero and the score cannot reach 100.",
  };
  const summaryPrefix = agentFirstReason
    ? (th
      ? "สแกน public signals สำเร็จ คะแนนนี้คำนวณจากสัญญาณจริงของเว็บ เช่น meta, schema, robots, sitemap, llms.txt และ Open Graph"
      : "Public-signal scan completed. This score is computed from real public signals such as metadata, schema, robots, sitemap, llms.txt, and Open Graph")
    : (th
      ? "สแกนพื้นฐานสำเร็จโดยไม่ใช้ Cloud LLM คะแนนนี้คำนวณจากสัญญาณจริงของเว็บ เช่น meta, schema, robots, sitemap, llms.txt และ Open Graph"
      : "Baseline scan completed without a Cloud LLM. This score is computed from real public signals such as metadata, schema, robots, sitemap, llms.txt, and Open Graph");
  return {
    url,
    summary: th
      ? `${summaryPrefix}${fixable.length ? ` พบจุดที่ควรแก้ ${fixable.length} จุด` : " ยังไม่พบจุดแก้จาก public signals ที่ตรวจได้"}${verificationNote}.${perfNote}`
      : `${summaryPrefix}${fixable.length ? ` with ${fixable.length} fixable gap(s)` : " with no fixable gaps found in the detected public signals"}${verificationNote}.${perfNote}`,
    overall: det.overall,
    grade: det.grade,
    categories,
    _scoring: "deterministic_rubric",
    _engine_provider: null,
    _llm_fallback: !agentFirstReason,
    _llm_error: reason || "llm_unavailable",
    _checks: det.checks,
    _category_scores: det.categories,
    _performance: det.performance,
    _performance_verified: det.performanceVerified,
    _performance_lite: facts.performanceLite,
    _score_status: det.performanceVerified ? "verified" : "provisional",
    _score_note: perfNote.trim(),
    _verification: verification,
    _facts: facts,
    _cwv: facts.coreWebVitals,
    _agent_recommended: true,
    _agent_reason: th
      ? "ถ้าต้องรู้ว่าคนดูมาจาก Google, AI, social หรือ ads ต้องให้ agent ตรวจ GA4, Google Search Console, UTM และ server/Cloudflare logs"
      : "Traffic source attribution requires the agent to inspect GA4, Google Search Console, UTM data, and server/Cloudflare logs.",
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const agentFirst = !!(payload.deterministic_only || payload.agent_first);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const rl = agentFirst
    ? { allowed: true, remaining: 999, resetIn: 0, enforced: false, bypassed: true, reason: "agent_first_no_llm" }
    : await checkRateLimit(env, ip);
  if (!rl.allowed) {
    const mins = Math.ceil(rl.resetIn / 60);
    return json(
      { error: `Rate limit reached. Try again in about ${mins} minute(s). // ถึงขีดจำกัดแล้ว ลองใหม่ในอีกประมาณ ${mins} นาที`,
        retryIn: rl.resetIn },
      429,
      { "Retry-After": String(rl.resetIn) }
    );
  }
  const url = normalizeUrl(payload.url);
  const userPrompt = (payload.prompt || "").toString().slice(0, 2000);
  if (!url) return json({ error: "Please provide a valid website URL." }, 400);

  // Opt-out gate — before any target fetch
  if (await isOptedOut(env, new URL(url).hostname)) {
    return json({ error: "host_opted_out", message: { th: "เจ้าของเว็บไซต์นี้ขอไม่ให้ AIBotAuth สแกน หากต้องการยกเลิก opt-out ติดต่อ Geowahaha@gmail.com", en: "The site owner has requested a permanent opt-out. Contact Geowahaha@gmail.com to reverse." } });
  }

  const root = new URL(url).origin;
  const alternateHomeUrl = oppositeWwwUrl(url);
  const [home, robots, sitemap, llms, psi, alternateHome] = await Promise.all([
    tryFetchText(env, url),
    tryFetchText(env, root + "/robots.txt"),
    tryFetchText(env, root + "/sitemap.xml"),
    tryFetchText(env, root + "/llms.txt"),
    fetchPSI(url, env),
    alternateHomeUrl ? tryFetchText(env, alternateHomeUrl, 9000) : Promise.resolve(null),
  ]);

  // robots.txt honoring gate — RFC 9309
  const botPolicy = aimarkBotAccess(robots.body || "", "/");
  if (!botPolicy.allowed) {
    return json({
      url,
      robots_policy: {
        aimarkbot_allowed: false,
        matched_group: botPolicy.matchedGroup,
        rule: botPolicy.rule,
        message: {
          th: "เว็บไซต์นี้ไม่อนุญาตให้ AIBotAuth อ่านเนื้อหาตาม robots.txt เราเคารพกฎนั้น จึงวิเคราะห์ได้เฉพาะ robots/sitemap/DNS — หากคุณเป็นเจ้าของเว็บ เพิ่ม User-agent: AIBotAuth / Allow: / เพื่อเปิดการตรวจเต็มรูปแบบ",
          en: "This site's robots.txt disallows AIBotAuth, so we honored it and analyzed only robots/sitemap/DNS-level signals. If you own this site, add User-agent: AIBotAuth Allow: / to enable full audits.",
        },
      },
      fetch: { robots: { status: robots.status, present: robots.ok && /(allow|disallow|user-agent)/i.test(robots.body) } },
      robotsTxt: robots.ok ? robots.body.slice(0, 3000) : "",
    });
  }

  const pageFacts = home.ok ? extractFacts(home.body) : null;
  const performanceLite = buildPerformanceLite(home);
  const facts = {
    requestedUrl: url,
    fetch: {
      home: { status: home.status, ok: home.ok, finalUrl: home.finalUrl, error: home.error || null },
      alternateHome: alternateHome ? { status: alternateHome.status, ok: alternateHome.ok, finalUrl: alternateHome.finalUrl, error: alternateHome.error || null } : null,
      robots: { status: robots.status, present: robots.ok && /(allow|disallow|user-agent)/i.test(robots.body) },
      sitemap: { status: sitemap.status, present: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body) },
      llms: { status: llms.status, present: llms.ok && llms.body.trim().length > 0 },
    },
    page: pageFacts,
    migration: migrationSignals(url, home.finalUrl, pageFacts, robots.body, sitemap.body, alternateHome),
    coreWebVitals: psi,
    performanceLite,
    robotsTxt: robots.ok ? robots.body.slice(0, 3000) : "",
    botPolicy: robots.ok ? botVerdict(robots.body) : null,
  };

  const lang = (payload.lang === "th") ? "th" : "en";
  const det = computeScores(facts); // authoritative, model-independent scores
  // Persist the audit (signed-in users only) — runs after the response in prod via
  // waitUntil; awaited in tests. Covers every return path below in one place.
  if (context.waitUntil) context.waitUntil(persistScanAudit(context, url, det));
  else await persistScanAudit(context, url, det);
  if (agentFirst) {
    return json({
      ...buildDeterministicScan(url, facts, det, lang, "agent_first_local_runner"),
      _agent_first: true,
      _agent_reason: lang === "th"
        ? "ใช้ deterministic scan ก่อน แล้วส่งงานที่ต้องใช้ reasoning/ข้อมูลจริงให้ local Codex agent เพื่อตัดการพึ่งพา Claude API"
        : "Using deterministic scan first, then handing reasoning and real-data work to the local Codex agent to avoid relying on the Claude API.",
      scanned_at: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
      _rateRemaining: rl.remaining,
    }, 200);
  }
  const userBlock =
    `Audit this website. Signals follow as JSON.\n\n` +
    `IMPORTANT: the numeric overall + category scores are computed by the system from the deterministic CHECK RESULTS below — do NOT invent different numbers (any scores you output will be overridden). Your job is the qualitative report: write a sharp "summary" and, for every check with status "fail", a specific, detailed finding with a concrete fix. Add any extra issues you genuinely observe in the signals. Cover the failed checks first, especially "critical"/"high".\n\n` +
    `Write the "summary" and every finding "detail" and "fix" in ${lang === "th" ? "Thai (ภาษาไทย)" : "English"}. Keep the four category "name" values and all JSON keys exactly as the system prompt specifies.\n\n` +
    (userPrompt ? `User focus / instructions: ${userPrompt}\n\n` : "") +
    `DETERMINISTIC CHECK RESULTS (authoritative — explain the fails):\n${JSON.stringify(det.checks, null, 2)}\n\n` +
    `RAW SIGNALS:\n${JSON.stringify(facts, null, 2)}`;

  const first = await callClaude(env, [{ role: "user", content: userBlock }], 8000);
  if (!first.ok) {
    return json(buildDeterministicScan(url, facts, det, lang, first.detail || first.error), 200);
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

  // Override LLM numbers with deterministic scores so the score is stable
  // regardless of which model (Claude/Groq/…) produced the narrative.
  scan.overall = det.overall;
  scan.grade = det.grade;
  if (Array.isArray(scan.categories)) {
    scan.categories.forEach((c) => {
      const key = Object.keys(det.categories).find((k) => k.toLowerCase() === String(c.name || "").toLowerCase());
      if (key) { c.score = det.categories[key]; c.grade = det.categories[key] >= 90 ? "A" : det.categories[key] >= 80 ? "B" : det.categories[key] >= 70 ? "C" : det.categories[key] >= 55 ? "D" : "F"; }
    });
  }
  scan._scoring = "deterministic_rubric";
  scan._engine_provider = first.provider || null;
  scan._checks = det.checks;          // ALL checks (pass + fail) so the UI can show both
  scan._category_scores = det.categories;
  scan._performance = det.performance;
  scan._performance_verified = det.performanceVerified;
  scan._performance_lite = facts.performanceLite;
  scan._score_status = det.performanceVerified ? "verified" : "provisional";
  scan._score_note = det.performanceVerified
    ? ""
    : (lang === "th"
      ? "Performance ยังไม่ได้ verify จึงกันคะแนน 12% ไว้ก่อนและไม่อนุญาตให้คะแนนเต็ม 100"
      : "Performance is not verified, so the 12% performance weight is held back and the score cannot be 100.");
  scan._verification = {
    score_status: scan._score_status,
    missing_evidence: det.checks
      .filter((c) => String(c.status || "").toLowerCase() === "unverified")
      .map((c) => ({ category: c.category, check: c.check, detail: c.detail || "" })),
    cannot_infer_from_public_scan: [
      "traffic_source_attribution",
      "GA4_sessions",
      "Google_Search_Console_clicks_queries",
      "ad_spend_or_CAC",
      "actual_AI_citations_without_live_probe",
    ],
    score_guardrail: det.performanceVerified
      ? "All weighted score components used by the deterministic rubric were available."
      : "Performance/Core Web Vitals could not be verified, so the 12% performance weight is held at zero and the score cannot reach 100.",
  };

  scan.url = scan.url || url;
  scan.scanned_at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  scan._fetch = facts.fetch; // expose raw fetch status to the UI
  scan._migration = facts.migration; // raw canonical/index migration evidence for QA/export
  scan._cwv = psi;           // raw Core Web Vitals for the metrics strip
  scan._rateRemaining = rl.remaining;
  return json(scan);
}
