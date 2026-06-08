/**
 * GET /api/intelligence/revenue?site=<siteId>  — "What generated revenue?" (Growth Intelligence).
 * The bridge from visibility to money: each applied recommendation attributed to the
 * leads + sales + revenue that followed it (honest time-ordered correlation), plus the
 * site's outcome totals. This is the dataset more valuable than any score, and the
 * single most powerful retention/upsell proof: "the fixes you applied -> ฿X revenue".
 */
import { requireSession } from "../_auth.js";
import { dbReady, ensureOrgForSession, getSite, publicSite, revenueAttribution } from "../_db.js";

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

  const attribution = await revenueAttribution(env, ctx.org_id, siteId);
  return jc({ status: "ok", site: publicSite(site), summary: attribution.totals, attribution });
}
