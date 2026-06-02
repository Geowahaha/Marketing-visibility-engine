/**
 * Cloudflare Pages Function — POST /api/answer-gap  (PRO: AI Answer Gap)
 * ------------------------------------------------------------------
 * The top-tier feature. For the buyer's real questions, it asks the LIVE AI
 * engines (Gemini w/ Google grounding + Tavily) "who do you recommend?", sees
 * which brands AI names today (usually competitors), checks if the client is
 * present, and turns each gap into a concrete "winning content angle + page to
 * create" so the client can BECOME the answer.
 *
 * Body: { url, business?, industry?, location?, questions?:[], lang? }
 * Pro feature. Free → 1-question teaser. Honest: observed at probe time only.
 * Env: ANTHROPIC/GROQ/KIMI (synthesis), GEMINI_API_KEY/TAVILY_API_KEY (live asks),
 *      SERPAPI_KEY (derive real questions), PAID_EXPORT_SECRET / *_BYPASS_IPS.
 */

import { callLLM } from "./_llm.js";
import { paid } from "./_auth.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 VisibilityEngine/1.0";

function normalizeUrl(u) { u = (u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u; try { return new URL(u).toString(); } catch { return ""; } }
function bareHost(u) { try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } }
function brandFromHost(h) { return (h.split(".")[0] || "").replace(/[-_]/g, " ").trim(); }

async function askGemini(env, q, timeoutMs = 20000) {
  if (!env.GEMINI_API_KEY) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent", {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, signal: ctrl.signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: `${q}\n\nName the specific businesses/brands you would recommend, with their websites.` }] }], tools: [{ google_search: {} }] }),
    });
    if (!r.ok) return { engine: "gemini", error: `gemini_${r.status}` };
    const d = await r.json(); const cand = (d.candidates || [])[0] || {};
    const text = (cand.content?.parts || []).map((p) => p.text || "").join(" ");
    const gm = cand.groundingMetadata || {};
    const sources = (gm.groundingChunks || []).map((c) => c.web?.uri).filter(Boolean);
    return { engine: "gemini", text, sources: [...new Set(sources)] };
  } catch { return { engine: "gemini", error: "gemini_unreachable" }; } finally { clearTimeout(t); }
}
async function askTavily(env, q, timeoutMs = 18000) {
  if (!env.TAVILY_API_KEY) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal, body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query: `${q} recommend specific businesses by name with websites`, include_answer: true, max_results: 8 }) });
    if (!r.ok) return { engine: "tavily", error: `tavily_${r.status}` };
    const d = await r.json();
    return { engine: "tavily", text: d.answer || "", sources: (d.results || []).map((x) => x.url).filter(Boolean) };
  } catch { return { engine: "tavily", error: "tavily_unreachable" }; } finally { clearTimeout(t); }
}
async function serpQuestions(env, seed, lang) {
  if (!env.SERPAPI_KEY || !seed) return [];
  try {
    const hl = lang === "th" ? "th" : "en"; const gl = lang === "th" ? "th" : "us";
    const r = await fetch(`https://serpapi.com/search.json?engine=google&hl=${hl}&gl=${gl}&q=${encodeURIComponent(seed)}&api_key=${encodeURIComponent(env.SERPAPI_KEY)}`);
    if (!r.ok) return []; const d = await r.json();
    return (d.related_questions || []).map((q) => q.question).filter(Boolean).slice(0, 4);
  } catch { return []; }
}

const SYNTH_SYSTEM = `You are AI Mark's GEO competitive analyst. For each buyer question you receive the LIVE answers AI engines gave (Gemini + Tavily, with sources). Determine WHO the AI currently recommends (named brands/domains), whether the client brand is present, and the exact content gap + winning angle for the client to become the cited answer (2026 GEO: answer-first, E-E-A-T, entity authority — not keyword stuffing).

Return ONLY JSON:
{
 "summary": str,
 "questions": [ {
   "question": str,
   "client_present": boolean,
   "ai_recommends": [str],         // brands/domains the AI named (competitors)
   "why_they_win": str,            // why AI picks them (content/authority reason)
   "your_gap": str,                // what the client is missing
   "winning_angle": str,           // how to become the answer
   "page_to_create": {"title": str, "target_question": str}
 } ],
 "priority_actions": [str],
 "honest_note": str
}
Rules: base "ai_recommends"/"client_present" ONLY on the provided live answers (don't invent). Be specific and actionable. Write human-facing text in the requested language. Note honestly that AI answers vary by user/time and this is observed at probe time.`;

function extractJson(text) { let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim(); const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s >= 0 && e > s) t = t.slice(s, e + 1); return JSON.parse(t); }

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await paid(request, env))) return json({ error: "AI Answer Gap is part of AI Mark Pro (top tier).", upgrade_required: true, checkout_url: "/api/checkout?product=pro" }, 402);
  if (!env.GEMINI_API_KEY && !env.TAVILY_API_KEY) return json({ live: false, setup_required: "Set GEMINI_API_KEY and/or TAVILY_API_KEY to probe live AI answers." }, 200);
  if (!env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY && !env.KIMI_API_KEY) return json({ error: "Server has no LLM key for synthesis." }, 500);

  let payload; try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide the client's URL." }, 400);
  const lang = payload.lang === "th" ? "th" : "en";
  const host = bareHost(url);
  const brand = (payload.business || brandFromHost(host) || "").trim();

  let questions = (payload.questions || []).map((q) => String(q || "").trim()).filter(Boolean).slice(0, 4);
  if (!questions.length) {
    const seed = [payload.industry || "", brand, payload.location || ""].filter(Boolean).join(" ").trim();
    questions = await serpQuestions(env, seed, lang);
  }
  if (!questions.length) questions = [`best ${payload.industry || brand || "provider"} ${payload.location || ""}`.trim(), `who is the most trusted ${payload.industry || brand || "provider"}?`];

  // Live: ask the AI engines each question.
  const asked = await Promise.all(questions.map(async (q) => {
    const [g, tv] = await Promise.all([askGemini(env, q), askTavily(env, q)]);
    return { question: q, answers: [g, tv].filter(Boolean).map((a) => a.error ? { engine: a.engine, error: a.error } : { engine: a.engine, text: (a.text || "").slice(0, 1500), sources: (a.sources || []).slice(0, 6) }) };
  }));

  // Synthesize the gap + winning angles.
  const out = await callLLM(env, {
    system: SYNTH_SYSTEM,
    messages: [{ role: "user", content: `Client brand: ${brand}\nClient domain: ${host}\nIndustry: ${payload.industry || ""}\nLocation: ${payload.location || ""}\nLanguage: ${lang}\n\nLIVE AI ANSWERS PER QUESTION:\n${JSON.stringify(asked, null, 2)}` }],
    maxTokens: 4000, temperature: 0.2,
  });
  if (!out.ok) return json({ error: "Answer-gap synthesis failed.", detail: out.detail }, out.status || 502);
  let gap; try { gap = extractJson(out.text); } catch { return json({ error: "Analyst did not return valid JSON.", raw: out.text.slice(0, 400) }, 502); }

  const present = (gap.questions || []).filter((q) => q.client_present).length;
  gap.url = url; gap.brand = brand; gap.probed_at = new Date().toISOString();
  gap.observed_share_of_answer = `${present}/${(gap.questions || []).length || 0}`;
  gap.engines_used = [env.GEMINI_API_KEY ? "gemini" : null, env.TAVILY_API_KEY ? "tavily" : null].filter(Boolean);
  gap.tier = "pro";
  return json(gap);
}
