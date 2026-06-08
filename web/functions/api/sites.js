/**
 * Cloudflare Pages Function — /api/sites  (Platform Phase 1)
 * GET  → list the signed-in org's sites (host, latest Visibility Score, audit count)
 * POST → connect a site { url, industry?, country? } (the "Connect Site" step)
 *
 * Multi-tenant: every read/write is scoped to the caller's org (via D1).
 */
import { json, requireSession } from "./_auth.js";
import { dbReady, ensureOrgForSession, ensureSite, getSite, listSites, publicSite, hostOf } from "./_db.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured", detail: "Bind D1 as AGENT_DB to use the platform." }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);
  const sites = (await listSites(env, ctx.org_id)).map(publicSite);
  return jc({ status: "ok", org_id: ctx.org_id, count: sites.length, sites });
}

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured", detail: "Bind D1 as AGENT_DB to use the platform." }, 501);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const url = String(body.url || "").trim();
  if (!url || !hostOf(url)) return jc({ error: "url_required" }, 400);

  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);
  const siteId = await ensureSite(env, ctx.org_id, url, {
    industry: body.industry ? String(body.industry).slice(0, 60) : null,
    country: body.country ? String(body.country).slice(0, 8) : null,
  });
  if (!siteId) return jc({ error: "could_not_create_site" }, 500);
  const site = await getSite(env, ctx.org_id, siteId);
  return jc({
    status: "connected",
    site: publicSite(site),
    next: { run_audit: "/api/scan", history: `/api/sites/${siteId}` },
  });
}
