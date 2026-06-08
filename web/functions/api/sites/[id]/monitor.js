/**
 * Cloudflare Pages Function — POST /api/sites/:id/monitor  (Platform Phase 3)
 * Toggle continuous monitoring for a site = the recurring-revenue switch. Turning
 * it on schedules periodic re-audits (driven by the monitoring Worker/cron) so a
 * visibility drop raises an alert without the owner re-scanning by hand.
 *
 * Body: { enabled: bool, frequency?: "daily"|"weekly"|"monthly" }
 */
import { requireSession } from "../../_auth.js";
import { dbReady, ensureOrgForSession, setMonitoring, publicSite } from "../../_db.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);
  const ctx = await ensureOrgForSession(env, session);
  if (!ctx) return jc({ error: "org_unavailable" }, 500);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const enabled = body.enabled !== false; // default true
  const freq = ["daily", "weekly", "monthly"].includes(body.frequency) ? body.frequency : "weekly";

  const site = await setMonitoring(env, ctx.org_id, String(params.id || ""), enabled, freq);
  if (!site) return jc({ error: "site_not_found" }, 404);
  return jc({ status: "ok", monitoring_enabled: !!site.monitoring_enabled, monitor_frequency: site.monitor_frequency, site: publicSite(site) });
}
