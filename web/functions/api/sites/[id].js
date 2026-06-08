/**
 * Cloudflare Pages Function — GET /api/sites/:id  (Platform Phase 1)
 * One site: details + its audit history = the Visibility Score TIME-SERIES that
 * turns a one-off scan into trackable improvement. Tenant-scoped (404 if the
 * site is not in the caller's org → no cross-tenant leakage).
 */
import { requireSession } from "../_auth.js";
import { dbReady, ensureOrgForSession, getSite, listAudits, publicSite } from "../_db.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);

  const id = String(params.id || "");
  const site = await getSite(env, ctx.org_id, id);
  if (!site) return jc({ error: "site_not_found" }, 404);

  const audits = await listAudits(env, ctx.org_id, id, 60);
  // Trend: oldest→newest score series for charting.
  const trend = audits
    .filter((a) => a.overall_score != null)
    .map((a) => ({ at: a.created_at, score: a.overall_score }))
    .reverse();
  const first = trend[0] && trend[0].score;
  const last = trend.length ? trend[trend.length - 1].score : null;
  return jc({
    status: "ok",
    site: publicSite(site),
    audits,
    trend,
    delta: (first != null && last != null) ? last - first : 0,
  });
}
