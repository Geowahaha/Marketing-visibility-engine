/**
 * GET /api/intelligence/impact?site=<siteId>  — Outcome Intelligence (the moat).
 * Correlates recommendation ADOPTION with the OUTCOME: for each applied
 * recommendation, the score delta from when it was applied to the next audit.
 * Per-customer this proves AIMark's value ("the fixes you applied moved you +N");
 * aggregated across customers this becomes the revenue/success-correlation dataset
 * that lets AIMark eventually PREDICT and SELL outcomes (Phase 3).
 */
import { requireSession } from "../_auth.js";
import { dbReady, ensureOrgForSession, getSite, publicSite, recommendationImpact } from "../_db.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);

  const siteId = String(new URL(request.url).searchParams.get("site") || "").trim();
  if (!siteId) return jc({ error: "site_required" }, 400);
  const site = await getSite(env, ctx.org_id, siteId);
  if (!site) return jc({ error: "site_not_found" }, 404);

  const impact = await recommendationImpact(env, ctx.org_id, siteId);
  return jc({ status: "ok", site: publicSite(site), impact });
}
