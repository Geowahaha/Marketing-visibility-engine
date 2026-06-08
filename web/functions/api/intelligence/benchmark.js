/**
 * GET /api/intelligence/benchmark?site=<siteId>  — Visibility Intelligence (data moat).
 * ------------------------------------------------------------------
 * "How do I compare to my industry on AI visibility?" Answered from the
 * accumulating cross-tenant dataset (anonymized — aggregate numbers only). This is
 * the mid-term product ("sell Intelligence") and the sharpest sales hook: a site
 * in the bottom of its cohort is a motivated buyer.
 *
 * Without ?site, returns the industries the dataset can already benchmark (coverage).
 */
import { requireSession } from "../_auth.js";
import { dbReady, ensureOrgForSession, getSite, publicSite } from "../_db.js";
import { siteBenchmark, coveredIndustries } from "../_intelligence.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);

  const url = new URL(request.url);
  const siteId = String(url.searchParams.get("site") || "").trim();

  // Dataset coverage (which industries the moat can already speak to).
  if (!siteId) {
    return jc({ status: "ok", coverage: await coveredIndustries(env, 1) });
  }

  const site = await getSite(env, ctx.org_id, siteId);
  if (!site) return jc({ error: "site_not_found" }, 404);
  const benchmark = await siteBenchmark(env, site);
  return jc({ status: "ok", site: publicSite(site), benchmark });
}
