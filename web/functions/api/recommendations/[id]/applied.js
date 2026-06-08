/**
 * POST /api/recommendations/:id/applied  — adoption capture (data moat).
 * The customer marks a recommendation as done. We record the adoption AND snapshot
 * the site's score at that moment, so the OUTCOME (the next audit's delta) becomes
 * measurable — the can't-backfill "did the customer act on the advice?" signal that
 * feeds Recommendation Adoption + revenue-correlation intelligence.
 */
import { requireSession } from "../../_auth.js";
import { dbReady, ensureOrgForSession, markRecommendationApplied } from "../../_db.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);

  const res = await markRecommendationApplied(env, ctx.org_id, String(params.id || ""), session.email);
  if (!res) return jc({ error: "recommendation_not_found" }, 404);
  return jc({ status: "applied", ...res });
}
