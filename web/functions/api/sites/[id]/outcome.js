/**
 * POST /api/sites/:id/outcome  — Human Outcome Stream (the data customers pay for).
 * The owner logs a real business result: a lead, LINE add, call, quotation, or sale
 * (with revenue). This is the can't-backfill bridge from visibility scores to money,
 * and the substrate for "what generated revenue?".
 *
 * Body: { type, value?, currency?, note?, source?, occurred_at? }
 *   type:  lead | line_add | phone_call | contact_form | quotation | meeting | sale | revenue
 *   value: monetary amount in the major unit (e.g. baht) for sale/revenue
 */
import { requireSession } from "../../_auth.js";
import { dbReady, ensureOrgForSession, getSite, recordOutcome, outcomeSummary, OUTCOME_TYPES } from "../../_db.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);

  const siteId = String(params.id || "");
  const site = await getSite(env, ctx.org_id, siteId);
  if (!site) return jc({ error: "site_not_found" }, 404);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const type = String(body.type || "").toLowerCase().trim();
  if (!OUTCOME_TYPES.includes(type)) return jc({ error: "invalid_type", allowed: OUTCOME_TYPES }, 400);
  const valueCents = Math.max(0, Math.round((Number(body.value) || 0) * 100));

  const rec = await recordOutcome(env, {
    orgId: ctx.org_id, siteId, type, valueCents,
    currency: body.currency || "thb", note: body.note || "", source: body.source || "manual",
    occurredAt: body.occurred_at || undefined,
  });
  if (!rec) return jc({ error: "could_not_record" }, 500);
  const summary = await outcomeSummary(env, ctx.org_id, siteId);
  return jc({ status: "recorded", outcome: rec, summary });
}
