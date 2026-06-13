/**
 * Cloudflare Pages Function — POST /api/bot-access  (live AI-bot crawl test)
 * ------------------------------------------------------------------
 * The real verification: instead of only reading robots.txt rules, we actually
 * request the pasted URL AS each major AI/search crawler and report what they
 * really get — served, blocked, JS-challenged, or login-walled. Combined with
 * the robots.txt verdict it answers the honest question: "Can this bot read you?"
 *
 * Works for websites AND social links (a Facebook/Instagram login wall shows up
 * as login_required; a YouTube/TikTok/LINE page usually shows as served).
 *
 * Body: { url }
 *
 * HONEST LIMIT (stated in the response): we send each bot's User-Agent from our
 * server IP. Sites that verify crawler identity by IP / reverse-DNS may treat
 * the *real* bot differently. robots.txt is advisory. This is a strong proxy,
 * not a guarantee — which is exactly why we report both signals.
 */

import { signedFetch } from "./_botauth.js";
import { aimarkBotAccess, isOptedOut } from "./_botpolicy.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });

// ── Rate limiting ─────────────────────────────────────────────────────────────
// bot-access does 8+ parallel live fetches per call — cap lower than verify-self.
const RL_WINDOW_SEC = 60;
const RL_MAX = 10;

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    ""
  );
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV || !ip) return { allowed: true };
  const key = `rl:bot-access:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    let rec = raw ? JSON.parse(raw) : null;
    if (!rec || now >= rec.resetAt) rec = { count: 0, resetAt: now + RL_WINDOW_SEC };
    if (rec.count >= RL_MAX) return { allowed: false, resetIn: rec.resetAt - now };
    rec.count += 1;
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(rec), { expirationTtl: rec.resetAt - now });
    return { allowed: true };
  } catch {
    return { allowed: true }; // fail-open: never block on KV error
  }
}

// ── SSRF guard ────────────────────────────────────────────────────────────────
// Rejects private/loopback/link-local IPs and cloud metadata endpoints.
//
// Alternative IP encodings (decimal/hex/octal/short-form) are already safe:
// the WHATWG URL parser (used by both Node and Cloudflare Workers) normalises
// ALL of them to canonical dotted-decimal before returning .hostname, so
// http://2130706433/, http://0x7f000001/, http://0177.0.0.1/, http://127.1/
// etc. all become "127.0.0.1" before our check ever runs. Verified: all 7
// alternative-encoding test cases blocked without any extra normalization code.
//
// DNS-rebinding limitation (accepted, documented):
// workerd does not expose post-resolution IP inspection, so a public hostname
// that DNS-resolves to a private IP would pass this guard and be fetched. This
// is an inherent limit of the runtime. Mitigations: (1) Cloudflare's egress
// network blocks RFC-1918 destinations at the network layer; (2) the opt-out
// gate and robots.txt gate both fire before any content is processed.

function isPrivateIpv4(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([m[1], m[2], m[3], m[4]].some((n) => Number(n) > 255)) return false;
  return (
    a === 0 ||                               // 0.0.0.0/8  current network
    a === 10 ||                              // 10.0.0.0/8  private
    a === 127 ||                             // 127.0.0.0/8 loopback
    (a === 169 && b === 254) ||              // 169.254.0.0/16 link-local + metadata
    (a === 172 && b >= 16 && b <= 31) ||     // 172.16.0.0/12 private
    (a === 192 && b === 168) ||              // 192.168.0.0/16 private
    (a === 100 && b >= 64 && b <= 127)       // 100.64.0.0/10 carrier-grade NAT
  );
}

function isPrivateIpv6(hostname) {
  // URL spec wraps IPv6 in brackets: [::1] → strip them
  const h = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return (
    h === "::" ||
    h === "::1" ||                                              // loopback
    /^fc/i.test(h) || /^fd/i.test(h) ||                        // fc00::/7 unique local
    /^fe[89ab]/i.test(h)                                        // fe80::/10 link-local
  );
}

// Known cloud metadata and internal-only hostnames
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",   // AWS IMDSv1 / Azure IMDS / GCP metadata
  "100.100.100.200",   // Alibaba Cloud ECS metadata
]);

/**
 * Returns an error string if the URL targets an internal/private address,
 * or null if the URL is safe to fetch.
 */
function ssrfGuard(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { return "invalid URL"; }
  if (!/^https?:$/i.test(parsed.protocol)) return "only http/https URLs are allowed";
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return `blocked host: ${host}`;
  if (isPrivateIpv4(host)) return `private or internal IP address not allowed: ${host}`;
  if (isPrivateIpv6(host)) return `private or internal IPv6 address not allowed: ${host}`;
  return null; // safe
}

// The crawlers that decide AI + search visibility, with their real UA strings.
const BOTS = [
  { id: "GPTBot",            ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",            engine: "ChatGPT (training/answers)" },
  { id: "OAI-SearchBot",     ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",   engine: "ChatGPT Search" },
  { id: "ChatGPT-User",      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",          engine: "ChatGPT browsing" },
  { id: "ClaudeBot",         ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",                                                  engine: "Claude" },
  { id: "Claude-SearchBot",  ua: "Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)",                                          engine: "Claude Search" },
  { id: "PerplexityBot",     ua: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",                                   engine: "Perplexity" },
  { id: "Googlebot",         ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",                                            engine: "Google Search / AI Overviews" },
  { id: "Bingbot",           ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",                                             engine: "Bing / Copilot" },
];
// Google-Extended is a robots-only token (controls Gemini/Vertex use); it doesn't fetch with its own UA.
const ROBOTS_ONLY = ["Google-Extended"];

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

// UNSIGNED by design: these simulate third-party bot UAs. Never add Web Bot Auth here (identity fraud). AIBotAuth-identity fetches use signedFetch.
async function fetchAs(url, ua, timeoutMs = 11000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": ua, "Accept": "text/html,*/*", "Accept-Language": "en,th;q=0.9" },
      redirect: "follow", signal: ctrl.signal, cf: { cacheTtl: 0 },
    });
    const body = await r.text();
    return { status: r.status, ok: r.ok, body, finalUrl: r.url, server: r.headers.get("server") || "" };
  } catch (e) {
    return { status: 0, ok: false, body: "", finalUrl: url, error: String(e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

const AIMARK_UA = "AIBotAuth/1.0 (+https://aibotauth.com/bot; site-owner-requested audit)";
async function fetchAsSelf(env, url, timeoutMs = 11000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await signedFetch(env, url, {
      headers: { "User-Agent": AIMARK_UA, "Accept": "text/html,*/*", "Accept-Language": "en,th;q=0.9" },
      redirect: "follow", signal: ctrl.signal, cf: { cacheTtl: 0 },
    });
    return { ok: r.ok, status: r.status, body: await r.text(), finalUrl: r.url, headers: Object.fromEntries(r.headers) };
  } catch (e) {
    return { ok: false, status: 0, body: "", error: String(e).slice(0, 160), finalUrl: url, headers: {} };
  } finally { clearTimeout(t); }
}

function classifyFetch(res) {
  if (!res || res.status === 0) return { fetch: "error", note: res?.error || "request failed" };
  const b = (res.body || "").slice(0, 6000).toLowerCase();
  const challenge = /just a moment|cf-browser-verification|attention required|enable javascript and cookies|cf-chl|please verify you are a human|access denied/i.test(b);
  const login = /log in to (facebook|instagram)|you must log in|please log in|loginform|content isn'?t available|page isn'?t available/i.test(b)
    && !/og:title|og:description/i.test(res.body.slice(0, 8000));
  if (res.status === 401 || res.status === 403) return { fetch: "blocked", note: `HTTP ${res.status}` };
  if (res.status === 429) return { fetch: "rate_limited", note: "HTTP 429" };
  if (res.status === 503 || challenge) return { fetch: "bot_challenge", note: "Firewall/JS challenge (e.g. Cloudflare bot-fight)" };
  if (login) return { fetch: "login_required", note: "Login wall — public crawlers can't read the content" };
  if (res.status >= 200 && res.status < 300) {
    const text = res.body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length < 200) return { fetch: "served_thin", note: "Served, but almost no readable text (likely JS-rendered)", textLen: text.length };
    return { fetch: "served", note: `Served ${text.length} chars of text`, textLen: text.length };
  }
  return { fetch: "other", note: `HTTP ${res.status}` };
}

/** Per-bot robots.txt verdict: blocked / allowed / not_specified. */
function robotsVerdict(robotsBody, botId) {
  if (!robotsBody) return "not_specified";
  const block = new RegExp(`User-agent:\\s*${botId}[\\s\\S]*?(?=user-agent:|$)`, "i");
  const star = /User-agent:\s*\*[\s\S]*?(?=user-agent:|$)/i;
  const m = robotsBody.match(block) || robotsBody.match(star);
  if (!m) return "not_specified";
  if (/Disallow:\s*\/\s*(?:\n|$)/i.test(m[0])) return "blocked";
  return "allowed";
}

function jsRenderRisk(servedRes) {
  if (!servedRes || !servedRes.body) return { likely: false, note: "No served page to analyze." };
  const html = servedRes.body;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const scripts = (html.match(/<script\b/gi) || []).length;
  const spaMarker = /__NEXT_DATA__|id=["']root["']|id=["']app["']|data-reactroot|ng-version|window\.__NUXT__/i.test(html);
  const likely = (text.length < 600 && scripts >= 3) || (spaMarker && text.length < 1200);
  return {
    likely,
    text_chars: text.length,
    script_tags: scripts,
    note: likely
      ? "This page renders most content with JavaScript. Bots that don't execute JS (most AI crawlers) may see little or none of it — pre-render or server-render the key content."
      : "Server-delivered HTML has enough readable text for crawlers.",
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a URL to test." }, 400);

  // SSRF guard — synchronous, before any network or KV operation
  const ssrfError = ssrfGuard(url);
  if (ssrfError) return json({ error: "invalid_target", detail: ssrfError }, 400);

  // Rate limit — 10 req/min/IP; fail-open if RATE_LIMIT_KV unbound
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, ip);
  if (!rl.allowed) {
    return json(
      { error: "rate_limited", detail: `Too many bot-access checks. Try again in ${Math.ceil(rl.resetIn / 60)} min.`, retry_after: rl.resetIn },
      429,
    );
  }

  // Opt-out gate — before any target fetch
  if (await isOptedOut(env, new URL(url).hostname)) {
    return json({ error: "host_opted_out", message: { th: "เจ้าของเว็บไซต์นี้ขอไม่ให้ AIBotAuth สแกน หากต้องการยกเลิก opt-out ติดต่อ Geowahaha@gmail.com", en: "The site owner has requested a permanent opt-out. Contact Geowahaha@gmail.com to reverse." } });
  }

  const root = new URL(url).origin;
  const robotsRes = await fetchAsSelf(env, `${root}/robots.txt`, 8000);
  const robotsBody = robotsRes.ok ? robotsRes.body : "";

  // robots.txt honoring gate for AIBotAuth — skip live fetches when blocked, still report robots analysis
  const botPolicy = aimarkBotAccess(robotsBody, "/");
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
      checked_at: new Date().toISOString(),
      robots_txt_present: robotsRes.status === 200,
      bots: BOTS.map((bot) => ({ bot: bot.id, engine: bot.engine, robots: robotsVerdict(robotsBody, bot.id), fetch: "skipped_aimarkbot_blocked", http_status: null, verdict: "skipped" })),
      robots_only: ROBOTS_ONLY.map((id) => ({ bot: id, robots: robotsVerdict(robotsBody, id), fetch: "robots_only" })),
      honest_note: "AIBotAuth itself is blocked by this site's robots.txt, so live fetch tests were skipped. Robots.txt policy analysis is shown above.",
    });
  }

  const selfRes = await fetchAsSelf(env, url);

  // Hit the URL as every bot, in parallel.
  const results = await Promise.all(BOTS.map(async (bot) => {
    const res = await fetchAs(url, bot.ua);
    const cls = classifyFetch(res);
    const robots = robotsVerdict(robotsBody, bot.id);
    let verdict;
    if (robots === "blocked") verdict = "blocked_by_robots";
    else if (cls.fetch === "served") verdict = "can_read";
    else if (cls.fetch === "served_thin") verdict = "partial_js_risk";
    else if (["blocked", "bot_challenge", "login_required", "rate_limited"].includes(cls.fetch)) verdict = "cannot_read";
    else verdict = "uncertain";
    return { bot: bot.id, engine: bot.engine, robots, fetch: cls.fetch, http_status: res.status, text_chars: cls.textLen ?? null, verdict, note: cls.note, _body: cls.fetch === "served" ? res.body : "" };
  }));

  const robotsOnly = ROBOTS_ONLY.map((id) => ({ bot: id, engine: "Gemini / Vertex (training)", robots: robotsVerdict(robotsBody, id), fetch: "robots_only", http_status: null, verdict: robotsVerdict(robotsBody, id) === "blocked" ? "blocked_by_robots" : "allowed_by_robots", note: "Robots-token only; controls AI use, not a fetching crawler." }));

  const served = results.find((r) => r.verdict === "can_read");
  const js = jsRenderRisk(served ? { body: served._body } : null);
  results.forEach((r) => delete r._body);

  const canRead = results.filter((r) => r.verdict === "can_read").length;
  const total = results.length;

  return json({
    url,
    checked_at: new Date().toISOString(),
    robots_txt_present: robotsRes.status === 200,
    summary: {
      can_read: canRead,
      total,
      headline: `${canRead}/${total} major AI/search crawlers can actually read this page` + (js.likely ? " — but content looks JavaScript-rendered, so even allowed bots may see little." : "."),
    },
    bots: results,
    robots_only: robotsOnly,
    js_render_risk: js,
    aimark_bot: { ua: AIMARK_UA, signed: true, http_status: selfRes.status, fetch: selfRes.ok ? "served" : "blocked_or_error" },
    honest_note: "We send each crawler's User-Agent from our server. Sites that verify crawler identity by IP/reverse-DNS may serve the real bot differently, and robots.txt is advisory — so we report both the policy (robots) and the observed fetch. This is a strong proxy, not a guarantee. Our own baseline fetch is made as AIBotAuth with an RFC 9421 Web Bot Auth signature (key directory: /.well-known/http-message-signatures-directory).",
  });
}
