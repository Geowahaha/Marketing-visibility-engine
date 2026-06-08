/**
 * Cloudflare Pages Function — POST /api/competitor  (deep analysis)
 * ------------------------------------------------------------------
 * The "not just a scanner" layer. Given a target URL + up to 3 competitors,
 * it runs the real /api/scan on each, then asks Claude to produce a head-to-
 * head gap analysis: where the target loses, the specific fixes that close
 * each gap, and an HONEST AI-citation readiness read for buyer queries
 * (readiness + observed structure — never a guaranteed-ranking claim).
 *
 * Body: { url, competitors?: string[], buyer_queries?: string[], scan?, business? }
 *
 * Paid feature (Growth Monitor / Fix Pack). Free callers get a scores-only
 * preview; the gap-closing fixes + citation roadmap are locked.
 *
 * Env: ANTHROPIC_API_KEY (required), CLAUDE_MODEL (optional),
 *      PAID_EXPORT_SECRET / *_BYPASS_IPS (unlock), SITE_ORIGIN (optional).
 */

import { callLLM } from "./_llm.js";
import { paidStatus, requireSession } from "./_auth.js";
import { ensureOrgForSession, ensureSite, recordCompetitor, recordCompetitorSnapshot, hostOf } from "./_db.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

function originOf(request, env) {
  if (env.SITE_ORIGIN) return String(env.SITE_ORIGIN).replace(/\/+$/, "");
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

/** Reuse the real scanner so competitor signal is identical to the target's. */
async function runScan(origin, url, cookieHeader) {
  try {
    const r = await fetch(`${origin}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok || data.error) return { url, ok: false, error: data.error || `scan_failed_${r.status}` };
    return {
      url: data.url || url,
      ok: true,
      overall: data.overall,
      grade: data.grade,
      categories: (data.categories || []).map((c) => ({ name: c.name, score: c.score })),
      summary: data.summary,
    };
  } catch (e) {
    return { url, ok: false, error: String(e) };
  }
}

function summarizeForPrompt(s) {
  if (!s.ok) return { url: s.url, error: s.error };
  return { url: s.url, overall: s.overall, grade: s.grade, categories: s.categories };
}

const SYSTEM_PROMPT = `You are AI Mark's competitive visibility analyst (2026 GEO/AEO + technical SEO + social). You receive real scan results for a TARGET site and up to 3 COMPETITORS, plus optional buyer queries. Produce an honest, decision-ready comparison.

Return ONLY JSON (no markdown/prose):
{
 "headline": string,                       // 1 sentence: where the target stands vs the field
 "scoreboard": [ {"url": string, "role": "target"|"competitor", "overall": integer, "grade": string, "best_category": string, "worst_category": string} ],
 "gaps": [ {"category": string, "target_score": integer, "best_competitor_score": integer, "gap": integer, "why_it_matters": string} ],
 "fixes_that_close_the_gap": [ {"priority": integer, "category": string, "action": string, "expected_effect": string, "effort": "small"|"medium"|"large"} ],
 "ai_citation_readiness": [ {"buyer_query": string, "target_ready": "strong"|"partial"|"weak", "reason": string, "what_would_make_it_citeable": string} ],
 "honest_note": string                     // remind: readiness/structure, not guaranteed ranking or live citation share
}

Rules: be specific and quantitative using the scores given. Rank gaps by size × business impact. For ai_citation_readiness, judge ONLY from structural readiness in the scans (schema, FAQ/answer blocks, entity clarity, crawler access) — never claim you measured live AI answers. If buyer_queries are empty, infer 2-3 realistic ones from the target's category profile.`;

function extractJson(text) {
  let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callClaude(env, content, maxTokens = 4000) {
  // Delegates to the shared multi-provider caller (Anthropic → Groq → Kimi).
  const r = await callLLM(env, { system: SYSTEM_PROMPT, messages: [{ role: "user", content }], maxTokens, temperature: 0 });
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail, status: r.status || 502 };
  return { ok: true, text: r.text, provider: r.provider };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY && !env.KIMI_API_KEY) return json({ error: "Server has no LLM key (set ANTHROPIC_API_KEY, GROQ_API_KEY, or KIMI_API_KEY)." }, 500);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a target URL." }, 400);

  const competitors = [...new Set((payload.competitors || []).map(normalizeUrl).filter(Boolean))]
    .filter((c) => c !== url)
    .slice(0, 3);
  const buyerQueries = (payload.buyer_queries || []).map((q) => String(q || "").trim()).filter(Boolean).slice(0, 3);

  const origin = originOf(request, env);
  const cookieHeader = request.headers.get("cookie") || "";
  const status = await paidStatus(request, env);

  // Real scans, in parallel, using the same engine as the public scanner.
  const [target, ...comps] = await Promise.all([runScan(origin, url, cookieHeader), ...competitors.map((c) => runScan(origin, c, cookieHeader))]);

  if (!target.ok) return json({ error: "Could not scan the target site.", detail: target.error }, 502);

  const scoreboardRaw = [
    { ...summarizeForPrompt(target), role: "target" },
    ...comps.filter((c) => c.ok).map((c) => ({ ...summarizeForPrompt(c), role: "competitor" })),
  ];

  // Free preview: return the scoreboard only; lock the analysis.
  if (!status.paid) {
    return json({
      url,
      preview: true,
      scoreboard: scoreboardRaw.map((s) => ({ url: s.url, role: s.role, overall: s.overall, grade: s.grade })),
      competitors_scanned: comps.filter((c) => c.ok).length,
      locked: {
        gaps: true, fixes_that_close_the_gap: true, ai_citation_readiness: true,
        message: {
          en: "Competitor gap analysis + AI-citation roadmap are part of Growth Monitor / Fix Pack.",
          th: "การวิเคราะห์ช่องว่างคู่แข่ง + แผนทำให้ถูกอ้างอิงโดย AI อยู่ในแพ็กเกจ Growth Monitor / Fix Pack",
        },
      },
      upgrade: { required: true, checkout_url: "/api/checkout?product=growth" },
    });
  }

  const userBlock =
    `Compare these real scan results.\n\n` +
    (payload.business ? `Target business: ${payload.business}\n` : "") +
    `Buyer queries: ${buyerQueries.length ? JSON.stringify(buyerQueries) : "(none provided — infer realistic ones)"}\n\n` +
    `TARGET:\n${JSON.stringify(summarizeForPrompt(target), null, 2)}\n\n` +
    `COMPETITORS:\n${JSON.stringify(comps.map(summarizeForPrompt), null, 2)}`;

  const out = await callClaude(env, userBlock, 4000);
  if (!out.ok) return json(out.detail ? { error: out.error, detail: out.detail } : { error: out.error }, out.status || 502);

  let analysis;
  try { analysis = extractJson(out.text); } catch { return json({ error: "Analyst did not return valid JSON.", raw: out.text.slice(0, 500) }, 502); }

  analysis.url = url;
  analysis.generated_at = new Date().toISOString();
  analysis.competitors_scanned = comps.filter((c) => c.ok).length;
  analysis.scan_errors = comps.filter((c) => !c.ok).map((c) => ({ url: c.url, error: c.error }));
  analysis.paid = true;

  // Compound the dataset: capture the competitor positions over time for the
  // signed-in site owner (best-effort; never blocks the comparison). Can't-backfill:
  // who is beating you on AI visibility, tracked across months.
  try {
    if (env.AGENT_DB && target.ok && comps.some((c) => c.ok)) {
      const session = await requireSession(request, env);
      if (session && session.email) {
        const ctx = await ensureOrgForSession(env, session);
        if (ctx) {
          const siteId = await ensureSite(env, ctx.org_id, url);
          if (siteId) {
            let captured = 0;
            for (const c of comps) {
              if (!c.ok) continue;
              await recordCompetitor(env, { orgId: ctx.org_id, siteId, competitorUrl: c.url });
              await recordCompetitorSnapshot(env, { orgId: ctx.org_id, siteId, competitorHost: hostOf(c.url), competitorScore: c.overall, targetScore: target.overall });
              captured += 1;
            }
            analysis.captured = captured;
          }
        }
      }
    }
  } catch { /* never break the comparison on dataset capture */ }

  return json(analysis);
}
