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

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

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
  const { request } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a URL to test." }, 400);

  const root = new URL(url).origin;
  const robotsRes = await fetchAs(`${root}/robots.txt`, BOTS[0].ua, 8000);
  const robotsBody = robotsRes.ok ? robotsRes.body : "";

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
    honest_note: "We send each crawler's User-Agent from our server. Sites that verify crawler identity by IP/reverse-DNS may serve the real bot differently, and robots.txt is advisory — so we report both the policy (robots) and the observed fetch. This is a strong proxy, not a guarantee.",
  });
}
