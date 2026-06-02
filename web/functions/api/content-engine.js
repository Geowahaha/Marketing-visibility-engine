/**
 * Cloudflare Pages Function — POST /api/content-engine  (GEO/AEO 2026)
 * ------------------------------------------------------------------
 * The "make AI recommend this brand" engine. It does NOT keyword-stuff. It:
 *   1. Pulls the REAL questions buyers ask (Google People-Also-Ask + related
 *      searches via SerpAPI) for the client's business + location.
 *   2. Builds a query/long-tail map clustered by buyer intent.
 *   3. Produces a high-quality, answer-first CONTENT PLAN (pages/articles) +
 *      INTERNAL-LINK plan, structured for AI citation (2026 E-E-A-T/GEO).
 *   4. Recommends a BACKLINK / citation distribution list (spread the entity
 *      across the web) and an ENTITY-BUILDING plan (schema sameAs, NAP, E-E-A-T,
 *      listings) so AI sees the brand as a trustworthy entity.
 *
 * Modes:
 *   default            → the full plan (query map + content plan + links +
 *                        backlinks + entity plan).
 *   { mode:"draft", title|slug, target_question } → one full, publish-ready
 *                        article (answer-first, structured, FAQ + schema).
 *
 * Body: { url, business?, industry?, location?, lang?, mode?, title?, target_question? }
 * Paid feature (Growth / Pro). Free callers get the query map + plan titles.
 * Env: ANTHROPIC/GROQ/KIMI (via _llm.js), SERPAPI_KEY (grounds the query map),
 *      PAID_EXPORT_SECRET / *_BYPASS_IPS.
 */

import { callLLM } from "./_llm.js";
import { paid } from "./_auth.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 VisibilityEngine/1.0";

function normalizeUrl(u) { u = (u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u; try { return new URL(u).toString(); } catch { return ""; } }

async function tryFetch(url, timeoutMs = 9000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "th,en;q=0.9" }, redirect: "follow", signal: ctrl.signal }); return { ok: r.ok, status: r.status, body: await r.text() }; }
  catch { return { ok: false, status: 0, body: "" }; } finally { clearTimeout(t); }
}

function pageContext(html) {
  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ""; };
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i), description: pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i), text_sample: text.slice(0, 2500) };
}

/** Real buyer questions: Google People-Also-Ask + related searches. */
async function serpQueries(env, seed, lang, timeoutMs = 18000) {
  if (!env.SERPAPI_KEY || !seed) return null;
  const hl = lang === "th" ? "th" : "en"; const gl = lang === "th" ? "th" : "us";
  const u = `https://serpapi.com/search.json?engine=google&hl=${hl}&gl=${gl}&q=${encodeURIComponent(seed)}&api_key=${encodeURIComponent(env.SERPAPI_KEY)}`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(u, { signal: ctrl.signal }); if (!r.ok) return { error: `serpapi_${r.status}` };
    const d = await r.json();
    return {
      people_also_ask: (d.related_questions || []).map((q) => q.question).filter(Boolean).slice(0, 10),
      related_searches: (d.related_searches || []).map((s) => s.query).filter(Boolean).slice(0, 12),
      organic_titles: (d.organic_results || []).map((o) => o.title).filter(Boolean).slice(0, 8),
    };
  } catch { return { error: "serpapi_unreachable" }; } finally { clearTimeout(t); }
}

/** What AI / web answer engines currently surface for the topic (conversational grounding). */
async function tavilyAsk(env, seed, timeoutMs = 16000) {
  if (!env.TAVILY_API_KEY || !seed) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query: seed, search_depth: "basic", include_answer: true, max_results: 8 }),
    });
    if (!r.ok) return { error: `tavily_${r.status}` };
    const d = await r.json();
    return { ai_answer: (d.answer || "").slice(0, 700), source_titles: (d.results || []).map((x) => x.title).filter(Boolean).slice(0, 8) };
  } catch { return { error: "tavily_unreachable" }; } finally { clearTimeout(t); }
}

const PLAN_SYSTEM = `You are AI Mark's GEO/AEO content + authority strategist working to CONFIRMED 2026 standards. Your job: make AI engines (ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews) cite this brand as the most trustworthy answer in its category — WITHOUT keyword stuffing. LLMs cite only 2-7 domains per answer, so quality, structure, E-E-A-T and entity authority win.

2026 GEO principles to apply: direct answer-first formatting; logical H2/H3 structure; precise context-rich answers to specific buyer questions; semantic depth (cover related sub-questions = topical authority); unique first-hand info/data/examples (not generic); strong E-E-A-T (named author/experience, sources, proof); entity clarity (consistent name, schema sameAs across the web); off-site citations/mentions build authority.

You receive the business context + REAL buyer questions (Google People-Also-Ask + related searches). Build a plan that targets those real questions. Return ONLY JSON:
{
 "business_summary": str,
 "primary_entity": str,                       // the brand as an entity (name)
 "query_map": { "clusters": [ {"theme": str, "buyer_questions": [str], "long_tail_keywords": [str] } ] },
 "content_plan": [ {"priority": int, "title": str, "slug": str, "target_question": str, "search_intent": "informational|commercial|transactional|local", "outline": [str], "word_target": int, "why_it_gets_cited": str} ],
 "internal_links": [ {"from_slug": str, "to_slug": str, "anchor": str} ],
 "backlinks": [ {"name": str, "type": "directory|industry|local|review|press|community|partner", "where": str, "why": str, "how_to_get": str, "effort": "low|medium|high"} ],
 "entity_plan": { "organization_schema_sameAs": [str], "nap_consistency": [str], "eeat_actions": [str], "listings_and_profiles": [str] },
 "expected_outcome": str
}
Rules: target the REAL questions provided; EXACTLY 5 content pieces ranked by priority; keep each "outline" to 4-6 short bullets; provide 6-8 backlinks (realistic for THIS niche + country — concrete directory/association/listing types); max 6 organization_schema_sameAs URLs; keep all text concise. Write all human-facing text in the requested language. Be honest — improvements take weeks and depend on execution; no guaranteed ranking. Output MUST be a single complete valid JSON object, no markdown fences.`;

const DRAFT_SYSTEM = `You are AI Mark's senior content writer for GEO/AEO 2026. Write ONE publish-ready page that AI engines will happily cite: answer-first, well-structured, genuinely useful, E-E-A-T strong, NOT keyword-stuffed. Detect language from the request and write in it.

Return ONLY JSON:
{
 "title": str,
 "slug": str,
 "meta_description": str (140-160 chars),
 "html": str,            // the article body as clean HTML: open with a 1-2 sentence DIRECT ANSWER (TL;DR), then H2/H3 sections, bullet/numbered lists where useful, a concrete proof/stat line (use a clearly-labeled [placeholder] if unknown), and a short FAQ section (3-5 Q&As). No <html>/<head> — body content only.
 "faq_jsonld": str,      // <script type="application/ld+json"> FAQPage matching the FAQ section
 "internal_link_suggestions": [str],
 "word_count": int
}
Rules: factual, specific to the business; lead with the direct answer (that's what AI quotes); use real structure; do not invent fake awards/reviews/numbers — use [placeholders] the owner fills. Quality over length.`;

function extractJson(text) { let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim(); const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s >= 0 && e > s) t = t.slice(s, e + 1); return JSON.parse(t); }

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY && !env.KIMI_API_KEY) return json({ error: "Server has no LLM key." }, 500);
  let payload; try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide the client's website URL." }, 400);
  const lang = payload.lang === "th" ? "th" : "en";
  const isPaid = await paid(request, env);

  const home = await tryFetch(url);
  const ctx = home.ok ? pageContext(home.body) : { title: url };

  // ---- Draft mode: one full publish-ready article (paid only) ----
  if (String(payload.mode || "") === "draft") {
    if (!isPaid) return json({ error: "Writing full pages is part of AI Mark Growth / Pro.", upgrade_required: true, checkout_url: "/api/checkout?product=growth" }, 402);
    const ask = `Write the page for this business.\nLanguage: ${lang}\nBusiness URL: ${url}\nBusiness: ${payload.business || ctx.title}\nIndustry: ${payload.industry || ""}\nLocation: ${payload.location || ""}\nPage title: ${payload.title || ""}\nTarget question to answer: ${payload.target_question || payload.title || ""}\nBusiness context (from their site): ${ctx.text_sample || ""}`;
    const out = await callLLM(env, { system: DRAFT_SYSTEM, messages: [{ role: "user", content: ask }], maxTokens: 4000, temperature: 0.2 });
    if (!out.ok) return json({ error: "Draft generation failed.", detail: out.detail }, out.status || 502);
    let draft; try { draft = extractJson(out.text); } catch { return json({ error: "Writer did not return valid JSON.", raw: out.text.slice(0, 400) }, 502); }
    draft.url = url; draft.generated_at = new Date().toISOString();
    return json({ mode: "draft", ...draft });
  }

  // ---- Plan mode: query map + content plan + links + backlinks + entity ----
  const seed = [payload.industry || "", payload.business || ctx.title || "", payload.location || ""].filter(Boolean).join(" ").trim().slice(0, 120);
  const [serp, tav] = await Promise.all([serpQueries(env, seed, lang), tavilyAsk(env, seed)]);

  const ask =
    `Build the GEO/AEO content + authority plan.\n` +
    `Language: ${lang}\nBusiness URL: ${url}\n` +
    `Business: ${payload.business || ctx.title || ""}\nIndustry: ${payload.industry || ""}\nLocation: ${payload.location || ""}\n` +
    `Business context (from their site): ${ctx.text_sample || ""}\n\n` +
    `REAL buyer queries (Google People-Also-Ask + related):\n${serp && !serp.error ? JSON.stringify(serp, null, 2) : "(none — infer realistic buyer questions)"}\n\n` +
    `What AI/web answer engines currently surface for this topic (Tavily — use to mirror how people phrase questions to ChatGPT/Perplexity):\n${tav && !tav.error ? JSON.stringify(tav, null, 2) : "(none)"}`;

  const out = await callLLM(env, { system: PLAN_SYSTEM, messages: [{ role: "user", content: ask }], maxTokens: 8000, temperature: 0.3 });
  if (!out.ok) return json({ error: "Plan generation failed.", detail: out.detail }, out.status || 502);
  let plan;
  try { plan = extractJson(out.text); }
  catch {
    // Retry once, compact, to avoid truncation/format issues.
    const repair = await callLLM(env, { system: PLAN_SYSTEM, messages: [{ role: "user", content: ask + "\n\nReturn ONLY one complete, compact, valid JSON object. Exactly 5 content pieces, 6-8 backlinks, short outlines, no markdown." }], maxTokens: 8000, temperature: 0.2 });
    try { plan = extractJson(repair.text); }
    catch { return json({ error: "Strategist did not return valid JSON after retry. Try again.", raw: (repair.text || out.text).slice(0, 300) }, 502); }
  }

  plan.url = url;
  plan.generated_at = new Date().toISOString();
  plan.query_source = [serp && !serp.error ? "Google People-Also-Ask + related (SerpAPI)" : null, tav && !tav.error ? "AI/web answers (Tavily)" : null].filter(Boolean).join(" + ") || "inferred";
  plan.paid = isPaid;

  if (!isPaid) {
    // Free preview: show the query map + page titles; lock outlines, backlinks, entity, drafts.
    plan.content_plan = (plan.content_plan || []).map((p) => ({ priority: p.priority, title: p.title, target_question: p.target_question, search_intent: p.search_intent, locked: true }));
    plan.backlinks = [{ locked: true }];
    plan.entity_plan = { locked: true };
    plan.internal_links = [{ locked: true }];
    plan.upgrade = { required: true, cta: { en: "Unlock full content drafts, backlink list & entity plan", th: "ปลดล็อกเนื้อหาเต็ม, รายการ backlink และแผนสร้างตัวตน" }, checkout_url: "/api/checkout?product=growth" };
  }
  return json(plan);
}
