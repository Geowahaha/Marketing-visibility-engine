/**
 * Cloudflare Pages Function — POST /api/deep-scan  (whole-site deep crawl)
 * ------------------------------------------------------------------
 * Homepage-only scans miss the pages that actually drag a site down. This
 * discovers internal pages (sitemap.xml + homepage links), fetches a bounded
 * set in parallel, scores each deterministically (technical / AEO / social),
 * and returns a per-page rollup + site aggregate + the weakest pages.
 *
 * Deterministic + fast + free (no LLM call) — it complements the AI homepage
 * scan rather than repeating it.
 *
 * Body: { url, max_pages? (default 8, capped 15) }
 */

import { signedFetch } from "./_botauth.js";
import { aimarkBotAccess, isOptedOut } from "./_botpolicy.js";

const AIMARK_UA = "AIMarkBot/1.0 (+https://aimark.pages.dev/bot; site-owner-requested audit)";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

async function fetchText(env, url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await signedFetch(env, url, { headers: { "User-Agent": AIMARK_UA, "Accept-Language": "th,en;q=0.9" }, redirect: "follow", signal: ctrl.signal, cf: { cacheTtl: 0 } });
    return { ok: r.ok, status: r.status, body: await r.text(), finalUrl: r.url, ct: r.headers.get("content-type") || "" };
  } catch (e) {
    return { ok: false, status: 0, body: "", finalUrl: url, error: String(e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

function facts(html, url) {
  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ""; };
  const metaName = (n) => pick(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']*)["']`, "i")) || pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${n}["']`, "i"));
  const metaProp = (p) => pick(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)["']`, "i")) || pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${p}["']`, "i"));
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const imgs = (html.match(/<img\b/gi) || []).length;
  const imgsAlt = (html.match(/<img\b[^>]*\balt=["'][^"']+["']/gi) || []).length;
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    metaDesc: metaName("description"),
    h1: (html.match(/<h1\b/gi) || []).length,
    canonical: /rel=["']canonical["']/i.test(html),
    viewport: /name=["']viewport["']/i.test(html),
    jsonld: /application\/ld\+json|schema\.org/i.test(html),
    og: !!(metaProp("og:title") || metaProp("og:description")),
    ogImage: !!metaProp("og:image"),
    twitter: /twitter:card/i.test(html),
    https: url.startsWith("https://"),
    imgs, imgsAlt,
    words: text ? text.split(" ").length : 0,
    faq: /faq|คำถาม|ถามบ่อย|how to|what is|why /i.test(text),
    lists: /<(ul|ol|table)\b/i.test(html),
    fresh: /20(2[4-9]|[3-9]\d)|updated|ล่าสุด/i.test(text),
    links: (html.match(/<a\b/gi) || []).length,
  };
}

function scorePage(f) {
  const tech = [[f.https, 16], [!!f.title && f.title.length >= 3 && f.title.length <= 70, 16], [!!f.metaDesc && f.metaDesc.length >= 45, 14], [f.viewport, 12], [f.h1 >= 1, 10], [f.canonical, 10], [f.jsonld, 12], [f.imgs === 0 || f.imgsAlt / Math.max(f.imgs, 1) >= 0.6, 10]];
  const aeo = [[f.words >= 300, 22], [f.faq, 20], [f.lists, 16], [f.fresh, 12], [f.links >= 4, 14], [f.jsonld, 16]];
  const social = [[f.og, 34], [f.ogImage, 33], [f.twitter, 33]];
  const pct = (arr) => Math.round(arr.filter(([ok]) => ok).reduce((a, [, w]) => a + w, 0) * 100 / arr.reduce((a, [, w]) => a + w, 0));
  const technical = pct(tech), ai = pct(aeo), soc = pct(social);
  return { technical, ai, social: soc, overall: Math.round(technical * 0.45 + ai * 0.35 + soc * 0.20) };
}

function parseSitemapLocs(xml) {
  return [...String(xml || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim()).filter(Boolean);
}

function internalLinks(html, base, host) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]+href=["']([^"'#]+)["']/gi)) {
    let full; try { full = new URL(m[1], base).toString().split("#")[0].replace(/\/$/, ""); } catch { continue; }
    const p = new URL(full);
    if (p.protocol.startsWith("http") && p.hostname.replace(/^www\./, "") === host && !/\.(jpg|jpeg|png|gif|svg|pdf|zip|mp4|webp|ico|css|js)$/i.test(p.pathname) && !/\/(admin|login|cart|checkout|wp-json|wp-admin)/i.test(p.pathname)) {
      out.push(full);
    }
  }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a URL to crawl." }, 400);
  const maxPages = Math.max(2, Math.min(15, parseInt(payload.max_pages, 10) || 8));

  // Opt-out gate — before any target fetch
  if (await isOptedOut(env, new URL(url).hostname)) {
    return json({ error: "host_opted_out", message: { th: "เจ้าของเว็บไซต์นี้ขอไม่ให้ AIMarkBot สแกน หากต้องการยกเลิก opt-out ติดต่อ Geowahaha@gmail.com", en: "The site owner has requested a permanent opt-out. Contact Geowahaha@gmail.com to reverse." } });
  }

  const origin = new URL(url).origin;
  const host = new URL(url).hostname.replace(/^www\./, "");

  const [home, robots, sitemap] = await Promise.all([
    fetchText(env, url),
    fetchText(env, `${origin}/robots.txt`, 7000),
    fetchText(env, `${origin}/sitemap.xml`, 8000),
  ]);
  if (!home.ok || !/text\/html|<html/i.test(home.ct + home.body.slice(0, 500))) {
    return json({ error: "Could not fetch the homepage as HTML.", detail: home.error || `status ${home.status}` }, 502);
  }

  // robots.txt honoring gate — RFC 9309; skip crawl loop when blocked
  const botPolicy = aimarkBotAccess(robots.body || "", "/");
  if (!botPolicy.allowed) {
    return json({
      url,
      robots_policy: {
        aimarkbot_allowed: false,
        matched_group: botPolicy.matchedGroup,
        rule: botPolicy.rule,
        message: {
          th: "เว็บไซต์นี้ไม่อนุญาตให้ AIMarkBot อ่านเนื้อหาตาม robots.txt เราเคารพกฎนั้น จึงวิเคราะห์ได้เฉพาะ robots/sitemap/DNS — หากคุณเป็นเจ้าของเว็บ เพิ่ม User-agent: AIMarkBot / Allow: / เพื่อเปิดการตรวจเต็มรูปแบบ",
          en: "This site's robots.txt disallows AIMarkBot, so we honored it and analyzed only robots/sitemap/DNS-level signals. If you own this site, add User-agent: AIMarkBot Allow: / to enable full audits.",
        },
      },
      pages: [],
      robots_txt: robots.ok ? robots.body.slice(0, 3000) : "",
    });
  }

  // Discover candidate pages: sitemap first (quality), then homepage links.
  const sitemapRobots = [...String(robots.body || "").matchAll(/^\s*Sitemap:\s*(.+)$/gim)].map((m) => m[1].trim());
  let locs = parseSitemapLocs(sitemap.body);
  if (!locs.length && sitemapRobots.length) {
    const sm = await fetchText(env, sitemapRobots[0], 8000);
    locs = parseSitemapLocs(sm.body);
  }
  const seen = new Set([url.replace(/\/$/, "")]);
  const candidates = [];
  for (const list of [locs, internalLinks(home.body, url, host)]) {
    for (const u of list) {
      const norm = normalizeUrl(u); if (!norm) continue;
      if (new URL(norm).hostname.replace(/^www\./, "") !== host) continue;
      const key = norm.replace(/\/$/, "");
      if (!seen.has(key)) { seen.add(key); candidates.push(norm); }
      if (candidates.length >= maxPages - 1) break;
    }
    if (candidates.length >= maxPages - 1) break;
  }

  // Score homepage + candidates in parallel.
  const targets = [url, ...candidates].slice(0, maxPages);
  const pages = await Promise.all(targets.map(async (p, i) => {
    const res = i === 0 ? home : await fetchText(env, p);
    if (!res.ok || !res.body) return { url: p, http_status: res.status, error: res.error || "fetch_failed" };
    const f = facts(res.body, res.finalUrl || p);
    const s = scorePage(f);
    return { url: res.finalUrl || p, http_status: res.status, title: f.title.slice(0, 80), ...s, signals: { meta_desc: !!f.metaDesc, jsonld: f.jsonld, og: f.og, h1: f.h1, words: f.words } };
  }));

  const ok = pages.filter((p) => !p.error);
  const avg = (k) => ok.length ? Math.round(ok.reduce((a, p) => a + (p[k] || 0), 0) / ok.length) : 0;
  const weakest = [...ok].sort((a, b) => a.overall - b.overall).slice(0, 3).map((p) => ({ url: p.url, overall: p.overall }));
  const missing = {
    meta_description: ok.filter((p) => !p.signals.meta_desc).length,
    json_ld: ok.filter((p) => !p.signals.jsonld).length,
    open_graph: ok.filter((p) => !p.signals.og).length,
    thin_content: ok.filter((p) => p.signals.words < 300).length,
  };

  return json({
    url, host,
    crawled_at: new Date().toISOString(),
    pages_scanned: ok.length,
    pages_failed: pages.length - ok.length,
    source: locs.length ? "sitemap + homepage links" : "homepage links",
    site_scores: { overall: avg("overall"), technical: avg("technical"), ai: avg("ai"), social: avg("social") },
    weakest_pages: weakest,
    site_gaps: missing,
    headline: `Crawled ${ok.length} pages · site avg ${avg("overall")}/100 · ${missing.json_ld} missing schema, ${missing.meta_description} missing meta description, ${missing.thin_content} thin pages.`,
    pages: pages.map((p) => p.error ? p : { url: p.url, overall: p.overall, technical: p.technical, ai: p.ai, social: p.social, title: p.title, http_status: p.http_status }),
  });
}
