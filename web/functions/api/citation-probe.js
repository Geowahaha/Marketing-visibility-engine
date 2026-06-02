/**
 * Cloudflare Pages Function — POST /api/citation-probe  (LIVE AI-citation)
 * ------------------------------------------------------------------
 * The honest "share of answer" metric. It actually asks live AI engines a
 * buyer's question and detects whether the brand/domain is NAMED or CITED.
 *
 *   - Gemini  (gemini-flash-latest) with Google Search grounding → answer text
 *              + grounding source URLs.
 *   - Perplexity (sonar) → answer text + citation URLs.
 *
 * For each (engine × query) we record: cited? (brand named in text OR domain in
 * sources), the matched snippet, and which competitors were named instead.
 *
 * Body: { url, business?, buyer_queries?: string[], competitors?: string[] }
 *
 * Paid feature. Free callers get a 1-query teaser on one engine; the full
 * matrix is locked.  This is OBSERVED presence on the day of the probe — not a
 * guaranteed or permanent ranking. We say so in the response.
 *
 * Env: GEMINI_API_KEY and/or PERPLEXITY_API_KEY (at least one to run live),
 *      PAID_EXPORT_SECRET / *_BYPASS_IPS (unlock).
 */

import { paidStatus } from "./_auth.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}
function bareHost(u) { try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } }
function brandFromHost(host) { return (host.split(".")[0] || "").replace(/[-_]/g, " ").trim(); }

/** Did this answer name the brand or cite the domain? */
function detectMention(text, sourceUrls, brandTerms, host) {
  const lc = (text || "").toLowerCase();
  const namedTerm = brandTerms.find((t) => t && t.length >= 3 && lc.includes(t.toLowerCase()));
  const citedSource = (sourceUrls || []).some((s) => bareHost(s) === host && host);
  let snippet = "";
  if (namedTerm) {
    const i = lc.indexOf(namedTerm.toLowerCase());
    snippet = (text || "").slice(Math.max(0, i - 60), i + namedTerm.length + 80).replace(/\s+/g, " ").trim();
  }
  return { cited: !!(namedTerm || citedSource), via: namedTerm ? "named_in_answer" : citedSource ? "cited_as_source" : "absent", snippet };
}

function findCompetitorsNamed(text, competitorHosts) {
  const lc = (text || "").toLowerCase();
  return competitorHosts.filter((h) => h && (lc.includes(h) || lc.includes(brandFromHost(h).toLowerCase()))).slice(0, 5);
}

async function askGemini(env, query, timeoutMs = 20000) {
  if (!env.GEMINI_API_KEY) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${query}\n\nRecommend specific real businesses/brands by name with their websites.` }] }],
        tools: [{ google_search: {} }],
      }),
    });
    if (!r.ok) return { engine: "gemini", error: `gemini_${r.status}`, detail: (await r.text()).slice(0, 200) };
    const d = await r.json();
    const cand = (d.candidates || [])[0] || {};
    const text = (cand.content?.parts || []).map((p) => p.text || "").join(" ");
    const gm = cand.groundingMetadata || {};
    const sources = (gm.groundingChunks || []).map((c) => c.web?.uri).filter(Boolean)
      .concat((gm.groundingSupports || []).flatMap((s) => s.web ? [s.web.uri] : []));
    return { engine: "gemini", text, sources: [...new Set(sources)] };
  } catch (e) {
    return { engine: "gemini", error: "gemini_unreachable", detail: String(e).slice(0, 160) };
  } finally { clearTimeout(t); }
}

async function askPerplexity(env, query, timeoutMs = 20000) {
  if (!env.PERPLEXITY_API_KEY) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${env.PERPLEXITY_API_KEY}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: env.PERPLEXITY_MODEL || "sonar",
        messages: [
          { role: "system", content: "Recommend specific real businesses/brands by name with their websites. Be concrete." },
          { role: "user", content: query },
        ],
      }),
    });
    if (!r.ok) return { engine: "perplexity", error: `perplexity_${r.status}`, detail: (await r.text()).slice(0, 200) };
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || "";
    const sources = d.citations || d.search_results?.map((s) => s.url) || [];
    return { engine: "perplexity", text, sources: [...new Set(sources)] };
  } catch (e) {
    return { engine: "perplexity", error: "perplexity_unreachable", detail: String(e).slice(0, 160) };
  } finally { clearTimeout(t); }
}

async function askTavily(env, query, timeoutMs = 20000) {
  if (!env.TAVILY_API_KEY) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: `${query} Recommend specific real businesses/brands by name with their websites.`,
        search_depth: "basic",
        include_answer: true,
        max_results: 8,
      }),
    });
    if (!r.ok) return { engine: "tavily", error: `tavily_${r.status}`, detail: (await r.text()).slice(0, 200) };
    const d = await r.json();
    const sources = (d.results || []).map((x) => x.url).filter(Boolean);
    return { engine: "tavily", text: d.answer || (d.results || []).map((x) => x.content).join(" "), sources: [...new Set(sources)] };
  } catch (e) {
    return { engine: "tavily", error: "tavily_unreachable", detail: String(e).slice(0, 160) };
  } finally { clearTimeout(t); }
}

async function askSerpApi(env, query, timeoutMs = 22000) {
  if (!env.SERPAPI_KEY) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const u = "https://serpapi.com/search.json?engine=google&num=10&hl=en&q=" +
      encodeURIComponent(query) + "&api_key=" + encodeURIComponent(env.SERPAPI_KEY);
    const r = await fetch(u, { signal: ctrl.signal });
    if (!r.ok) return { engine: "google", error: `serpapi_${r.status}`, detail: (await r.text()).slice(0, 200) };
    const d = await r.json();
    const aiOverview = d.ai_overview
      ? (d.ai_overview.text_blocks || []).map((b) => b.snippet || (b.list || []).map((x) => x.snippet).join(" ")).join(" ")
      : "";
    const answerBox = d.answer_box ? (d.answer_box.answer || d.answer_box.snippet || "") : "";
    const organic = d.organic_results || [];
    const text = [aiOverview, answerBox, ...organic.slice(0, 8).map((o) => `${o.title || ""} ${o.snippet || ""}`)].filter(Boolean).join(" ");
    const sources = organic.map((o) => o.link).filter(Boolean);
    return { engine: "google", text, sources: [...new Set(sources)] };
  } catch (e) {
    return { engine: "google", error: "serpapi_unreachable", detail: String(e).slice(0, 160) };
  } finally { clearTimeout(t); }
}

function runEngine(name, env, q) {
  if (name === "gemini") return askGemini(env, q);
  if (name === "perplexity") return askPerplexity(env, q);
  if (name === "tavily") return askTavily(env, q);
  if (name === "google") return askSerpApi(env, q);
  return Promise.resolve(null);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide the brand's URL." }, 400);
  const host = bareHost(url);
  const brandTerms = [...new Set([payload.business, brandFromHost(host), host].filter(Boolean))];
  const competitorHosts = (payload.competitors || []).map(normalizeUrl).map(bareHost).filter(Boolean);

  let queries = (payload.buyer_queries || []).map((q) => String(q || "").trim()).filter(Boolean).slice(0, 4);
  if (!queries.length) {
    const b = brandFromHost(host) || "this kind of business";
    queries = [`What are the best ${b} options?`, `Who should I hire for ${b}?`];
  }

  const engines = [];
  if (env.GEMINI_API_KEY) engines.push("gemini");
  if (env.PERPLEXITY_API_KEY) engines.push("perplexity");
  if (env.TAVILY_API_KEY) engines.push("tavily");
  if (env.SERPAPI_KEY) engines.push("google");
  if (!engines.length) {
    return json({
      url, live: false,
      setup_required: "Set GEMINI_API_KEY, PERPLEXITY_API_KEY, TAVILY_API_KEY, or SERPAPI_KEY to run the live probe.",
      note: "Until a provider key is set this endpoint can only report readiness (see /api/scan), not observed AI answers.",
    }, 200);
  }

  const status = await paidStatus(request, env);
  // Free teaser: one query, one engine.
  const runQueries = status.paid ? queries : queries.slice(0, 1);
  const runEngines = status.paid ? engines : engines.slice(0, 1);

  const results = [];
  for (const q of runQueries) {
    const answers = await Promise.all(runEngines.map((e) => runEngine(e, env, q)));
    for (const a of answers) {
      if (!a) continue;
      if (a.error) { results.push({ query: q, engine: a.engine, error: a.error, detail: a.detail }); continue; }
      const m = detectMention(a.text, a.sources, brandTerms, host);
      results.push({
        query: q, engine: a.engine,
        cited: m.cited, via: m.via,
        snippet: m.snippet || "",
        competitors_named: findCompetitorsNamed(a.text, competitorHosts),
        sources: (a.sources || []).slice(0, 6),
      });
    }
  }

  const scored = results.filter((r) => !r.error);
  const citedCount = scored.filter((r) => r.cited).length;
  const out = {
    url, host, live: true,
    engines_used: runEngines,
    brand_terms: brandTerms,
    probed_at: new Date().toISOString(),
    observed_share_of_answer: scored.length ? `${citedCount}/${scored.length}` : "0/0",
    results,
    honest_note: "This is OBSERVED presence at probe time on the engines/queries tested — AI answers vary by user, location, and time. It is not a guaranteed or permanent ranking, and absence here does not mean the brand is never cited.",
  };

  if (!status.paid) {
    out.preview = true;
    out.upgrade = {
      required: true,
      cta: { en: "Run the full citation probe across all engines + your buyer queries", th: "ตรวจการถูกอ้างอิงเต็มรูปแบบทุกเอนจินและทุกคำค้นของลูกค้า" },
      checkout_url: "/api/checkout?product=growth",
    };
  }
  return json(out);
}
