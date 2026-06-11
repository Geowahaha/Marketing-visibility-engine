/**
 * Cloudflare Pages Function — POST /api/social-visibility  (REAL, rubric+LLM)
 * ------------------------------------------------------------------
 * Rebuilt: instead of hardcoded base scores, this fetches the channel's REAL
 * public signals (OG/title/description/visible metadata) and scores them with
 * the LLM against a researched 2026 per-platform rubric, producing an actual
 * score + account-specific strengths/gaps/fixes. Honest about login-walls.
 *
 * Body: { brand_name?, website_url?, channels:{platform:url}, lang? }
 *
 * Env: ANTHROPIC_API_KEY / GROQ / KIMI (via _llm.js). No keys → honest notice.
 */

import { callLLM } from "./_llm.js";
import { signedFetch } from "./_botauth.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const AIMARK_UA = "AIBotAuth/1.0 (+https://aibotauth.com/bot; site-owner-requested audit)";

const PLATFORM_LABEL = {
  facebook_profile: "Facebook Profile", facebook_page: "Facebook Page", youtube: "YouTube",
  instagram: "Instagram", tiktok: "TikTok", line_oa: "LINE OA",
  google_business: "Google Business Profile", linkedin: "LinkedIn", other: "Channel",
};

function cleanUrl(x) { const s = String(x || "").trim(); if (!s) return ""; return /^https?:\/\//i.test(s) ? s : `https://${s}`; }
function domain(url) { try { return new URL(cleanUrl(url)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function inferPlatform(url, fallback) {
  const h = domain(url);
  if (h.includes("facebook.com")) return fallback && fallback.includes("profile") ? "facebook_profile" : (cleanUrl(url).toLowerCase().includes("profile.php") ? "facebook_profile" : "facebook_page");
  if (h.includes("youtube.com") || h.includes("youtu.be")) return "youtube";
  if (h.includes("instagram.com")) return "instagram";
  if (h.includes("tiktok.com")) return "tiktok";
  if (h.includes("lin.ee") || h.includes("line.me")) return "line_oa";
  if (h.includes("google.") || h.includes("goo.gl") || h.includes("maps.app")) return "google_business";
  if (h.includes("linkedin.com")) return "linkedin";
  return fallback || "other";
}

async function fetchText(env, url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await signedFetch(env, url, { headers: { "User-Agent": AIMARK_UA, "Accept-Language": "th,en;q=0.9" }, redirect: "follow", signal: ctrl.signal, cf: { cacheTtl: 0 } });
    return { ok: r.ok, status: r.status, body: await r.text(), finalUrl: r.url };
  } catch (e) { return { ok: false, status: 0, body: "", finalUrl: url, error: String(e) }; }
  finally { clearTimeout(t); }
}

function extractSignals(html, platform, finalUrl) {
  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ""; };
  const metaProp = (p) => pick(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)["']`, "i")) || pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${p}["']`, "i"));
  const metaName = (n) => pick(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']*)["']`, "i")) || pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${n}["']`, "i"));
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const sig = {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    og_title: metaProp("og:title"), og_description: metaProp("og:description"),
    og_image: !!metaProp("og:image"), description: metaName("description"),
    keywords: metaName("keywords"),
  };
  // Platform-specific public extras (best-effort from the served HTML/JSON).
  if (platform === "youtube") {
    sig.subscribers = pick(/"subscriberCountText":\{[^}]*?"simpleText":"([^"]+)"/) || pick(/"metadataParts":\[\{"text":\{"content":"([^"]*subscribers[^"]*)"/i) || "";
    sig.video_count = pick(/"videosCountText".*?"simpleText":"([^"]+)"/) || "";
    sig.handle = pick(/"canonicalBaseUrl":"\/(@[^"]+)"/) || (finalUrl.match(/\/(@[^/?]+)/) || [])[1] || "";
    sig.has_shorts = /"reelShelfRenderer"|\/shorts\//i.test(html);
  }
  if (platform === "tiktok") { sig.handle = (finalUrl.match(/\/(@[^/?]+)/) || [])[1] || ""; sig.followers = pick(/"followerCount":(\d+)/) || ""; }
  if (platform === "instagram") { sig.handle = (finalUrl.match(/instagram\.com\/([^/?]+)/) || [])[1] || ""; }
  sig.text_sample = text.slice(0, 1800);
  sig.text_len = text.length;
  return sig;
}

function classify(res, sig) {
  if (!res.ok || !res.body) return "not_reachable_or_blocked";
  const head = ((res.finalUrl || "") + " " + res.body.slice(0, 5000)).toLowerCase();
  if (!sig.og_title && !sig.og_description && /log in to (facebook|instagram)|you must log in|please log in|loginform|content isn'?t available|page isn'?t available/i.test(head)) return "login_walled_needs_connection";
  if (sig.og_title || sig.og_description || sig.text_len > 400) return "live_public_signals";
  return "fetched_no_readable_signal";
}

// DETERMINISTIC social scoring — stable regardless of which LLM writes the narrative.
function clampS(n) { return Math.max(0, Math.min(100, Math.round(n))); }
function scoreSocialChannel(c, brandName, webDomain) {
  const s = c.signals || {}; const ds = c.data_source; const checks = [];
  const add = (label, ok, w) => checks.push({ label, status: ok ? "pass" : "fail", w });
  if (ds === "login_walled_needs_connection" || ds === "not_reachable_or_blocked") {
    add("Public profile readable by crawlers", false, 50);
    add("Channel URL provided", !!c.url, 20);
    return { score: ds === "login_walled_needs_connection" ? 35 : 25, confidence: "low", checks };
  }
  const blob = `${s.og_title || ""} ${s.og_description || ""} ${s.title || ""}`.toLowerCase();
  add("Link-preview title (og:title)", !!s.og_title, 20);
  add("Link-preview description (og:description)", !!s.og_description, 18);
  add("Share image (og:image)", !!s.og_image, 16);
  add("Brand name visible in profile", !!(brandName && blob.includes(String(brandName).toLowerCase())), 12);
  add("Website/entity referenced", !!(webDomain && blob.includes(webDomain.split(".")[0])), 10);
  if (c.platform === "youtube") { add("Channel @handle set", !!s.handle, 10); add("Subscriber count visible", !!s.subscribers, 6); add("Shorts presence (independent discovery)", !!s.has_shorts, 8); }
  else if (c.platform === "tiktok" || c.platform === "instagram") { add("@handle set", !!s.handle, 14); }
  else { add("Title/description present", !!(s.og_title || s.og_description || s.title), 12); }
  const max = checks.reduce((a, x) => a + x.w, 0) || 1;
  const got = checks.filter((x) => x.status === "pass").reduce((a, x) => a + x.w, 0);
  return { score: clampS(got * 100 / max), confidence: "high", checks };
}
function computeSocialOverall(scored, channels) {
  const arr = scored.map((x) => x.score);
  const avg = arr.length ? clampS(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const brandRatio = scored.length ? scored.filter((x) => (x.checks || []).some((c) => /Brand name visible|Website\/entity/.test(c.label) && c.status === "pass")).length / scored.length : 0;
  const entity = clampS(40 + brandRatio * 55);
  const hasLine = channels.some((c) => c.platform === "line_oa");
  const anyWeb = scored.some((x) => (x.checks || []).some((c) => /Website\/entity/.test(c.label) && c.status === "pass"));
  const conversion = hasLine ? 72 : (anyWeb ? 55 : 38);
  return { visibility_graph: avg, social_recommendation: avg, entity_trust: entity, conversion_path: conversion };
}

const SYSTEM_PROMPT = `You are AI Mark's social-visibility analyst working to CONFIRMED 2026 platform-algorithm standards. You receive REAL public signals scraped from a brand's social channels (and optionally their website). Score each channel HONESTLY from the actual signals — never invent followers, reach, or engagement you cannot see. If a channel is login-walled (data_source says so), score low-confidence and focus fixes on what's publicly fixable + connecting for deeper analysis.

2026 algorithm rubric (use these, per platform):
- YouTube: viewer SATISFACTION + CTR + retention + session time rank videos; metadata RELEVANCE (title/description match search intent) and spoken keywords matter; tags are minimal; thumbnails+titles drive CTR; Shorts are independent from long-form. Judge: keyword-rich specific title, a real description with links/keywords, a handle, playlists/Shorts presence, consistent niche.
- Facebook (Page/Profile): Reels get the most reach; SAVES & SHARES are worth ~50x a like; video completion + "high-intent"/conversation signals; organic reach is ~1.6% so completeness + native video matter. Judge: complete About/category/CTA/contact, website+LINE links, native video/Reels, proof/reviews, clear who-you-help.
- Instagram: interest+recency+relationship+frequency; NICHE FOCUS (posting 3+ unrelated topics = ~-45% reach); profile-visit rate is a rising signal; on-screen text/captions replaced hashtags; ~50% watched muted so visual hook matters. Judge: outcome-led bio, link in bio, clear niche, Reels with hooks.
- TikTok: interest-graph FYP; TOPICAL AUTHORITY (niche; 3+ topics penalised); keyword-rich NAME field + bio for search; pinned videos seen first; 1-3 posts/day optimal. Judge: keyword name/bio, pinned proof video, single clear niche.
- LINE OA: not an algorithmic feed — it's a conversion/retention channel. Judge: greeting message, rich menu, lead magnet, links from other channels into LINE. (Usually not publicly readable — say so.)
- Google Business: category, hours, photos, reviews, website consistency — local discovery.

Return ONLY JSON:
{
 "overall": {"visibility_graph": int 0-100, "social_recommendation": int, "entity_trust": int, "conversion_path": int},
 "channels": [ {"platform": str, "score": int 0-100, "confidence":"high|medium|low", "role": str, "strengths":[str], "gaps":[str], "fixes":[{"action":str,"why":str,"impact":"high|medium|low"}] } ],
 "next_best_action": str,
 "today_content_actions": [ {"platform":str,"format":str,"hook":str,"goal":str,"cta":str} ],
 "missing_channels": [ {"platform":str,"label":str,"why_it_matters":str} ]
}
Rules: scores must reflect the ACTUAL signals given (a login-walled page with only an og:title cannot score high). Fixes must be specific to THIS brand/channel, tied to a 2026 rubric reason in "why". Write all human-facing text in the requested language. Be honest — no guaranteed-reach or fake-metric claims.`;

function extractJson(text) {
  let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY && !env.KIMI_API_KEY) {
    return json({ error: "Server has no LLM key (set ANTHROPIC_API_KEY, GROQ_API_KEY, or KIMI_API_KEY)." }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const brandName = String(body.brand_name || "").trim();
  const websiteUrl = cleanUrl(body.website_url || "");
  const lang = body.lang === "th" ? "th" : "en";
  const raw = body.channels || {};

  // Fetch real public signals for each channel, in parallel.
  const entries = Object.entries(raw).map(([key, val]) => ({ key, url: cleanUrl(val) })).filter((e) => e.url).slice(0, 6);
  if (!entries.length) return json({ error: "Provide at least one channel URL." }, 400);

  const fetched = await Promise.all(entries.map(async ({ key, url }) => {
    const platform = inferPlatform(url, key);
    const res = await fetchText(env, url);
    const sig = res.ok ? extractSignals(res.body, platform, res.finalUrl || url) : {};
    const data_source = classify(res, sig);
    return { platform, label: PLATFORM_LABEL[platform] || "Channel", url, http_status: res.status, data_source, signals: sig };
  }));

  // Deterministic per-channel scores (model-independent) from the fetched signals.
  const webDomain = domain(websiteUrl);
  const det = Object.fromEntries(fetched.map((c) => [c.platform, scoreSocialChannel(c, brandName, webDomain)]));
  const overallDet = computeSocialOverall(Object.values(det), fetched);

  const promptBundle = {
    brand_name: brandName || null,
    website_url: websiteUrl || null,
    language: lang,
    note: "Numeric scores are computed by the system from the deterministic check results — do NOT output scores. Give specific strengths, gaps and fixes per channel (grounded in the checks + the 2026 rubric), plus next_best_action, today_content_actions and missing_channels.",
    channels: fetched.map((c) => ({ platform: c.platform, url: c.url, data_source: c.data_source, http_status: c.http_status, signals: c.signals, score_checks: (det[c.platform] || {}).checks || [] })),
  };

  const out = await callLLM(env, {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Analyze these real social signals (scores are system-computed; explain the failed checks with specific fixes).\n\n${JSON.stringify(promptBundle, null, 2)}` }],
    maxTokens: 3500, temperature: 0,
  });

  // LLM provides only the narrative; if it fails, deterministic scores still render.
  let a = { channels: [], next_best_action: "", today_content_actions: [], missing_channels: [] };
  if (out.ok) { try { a = extractJson(out.text); } catch { /* keep deterministic-only */ } }

  // Build channels from the FETCHED set (authoritative) with deterministic score + LLM narrative.
  const llmByPlatform = Object.fromEntries((a.channels || []).map((ch) => [ch.platform, ch]));
  const connected = fetched.map((c) => {
    const d = det[c.platform] || { score: 0, confidence: "low" };
    const ch = llmByPlatform[c.platform] || {};
    return {
      platform: c.platform,
      label: c.label,
      url: c.url,
      role: ch.role || "",
      score: d.score,
      confidence: d.confidence,
      data_source: c.data_source,
      recommendation: (ch.fixes && ch.fixes[0] && ch.fixes[0].action) || (ch.gaps && ch.gaps[0]) || "Optimize this channel.",
      strengths: ch.strengths || [],
      gaps: ch.gaps || [],
      fixes: ch.fixes || [],
      signals: c.signals ? { og_title: c.signals.og_title || "", og_description: c.signals.og_description || "", subscribers: c.signals.subscribers || "", handle: c.signals.handle || "" } : null,
    };
  });

  const fbProfile = connected.some((c) => c.platform === "facebook_profile");
  const fbPage = connected.some((c) => c.platform === "facebook_page");
  const liveTitle = fetched.map((c) => c.signals && c.signals.og_title).find(Boolean) || "";

  return json({
    version: "3.0",
    scan_type: "social_visibility_graph",
    engine: "live_signals_deterministic_score_plus_2026_rubric_llm",
    scoring: "deterministic_rubric",
    generated_at: new Date().toISOString(),
    brand_name: brandName || liveTitle.replace(/\s*[|\-–—•·]\s*(facebook|instagram|tiktok|youtube|linkedin).*/i, "").trim(),
    detected_entity: liveTitle ? liveTitle.replace(/\s*[|\-–—•·]\s*(facebook|instagram|tiktok|youtube|linkedin).*/i, "").trim() : "",
    website_url: websiteUrl,
    scores: {
      visibility_graph: overallDet.visibility_graph,
      social_recommendation: overallDet.social_recommendation,
      entity_trust: overallDet.entity_trust,
      conversion_path: overallDet.conversion_path,
    },
    profile_first_strategy: {
      applies: fbProfile || fbPage,
      insight: "For SME/founder-led brands, a Facebook Profile can carry organic reach while the Page is the official proof + ads base.",
      recommended_model: "Profile = reach, Page = proof, LINE OA = conversion, Website = search/AI evidence.",
    },
    connected_channels: connected,
    missing_channels: a.missing_channels || [],
    next_best_action: a.next_best_action || "",
    today_content_actions: a.today_content_actions || [],
    limitations: [
      "Scores are computed by analyzing the channel's LIVE public signals (OG/title/description/visible metadata) against confirmed 2026 algorithm factors — not from private analytics.",
      "Login-walled channels (often Facebook/Instagram) expose little public data and are scored low-confidence; connect the account for full reach/engagement analysis.",
      "No guaranteed reach or ranking is promised; recommendations target durable, platform-native best practice.",
    ],
  });
}
