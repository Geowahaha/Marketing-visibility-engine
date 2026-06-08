/**
 * Cloudflare Pages Function — GET /api/alerts  (Platform Phase 3)
 * The signed-in org's visibility alerts (score drops etc.) — the reason customers
 * come back. Tenant-scoped.
 */
import { requireSession } from "./_auth.js";
import { dbReady, ensureOrgForSession, listAlerts } from "./_db.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);
  const alerts = await listAlerts(env, ctx.org_id, 50);
  const unread = alerts.filter((a) => !a.read_at).length;
  return jc({ status: "ok", count: alerts.length, unread, alerts });
}
