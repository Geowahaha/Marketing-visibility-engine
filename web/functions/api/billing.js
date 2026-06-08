/**
 * Cloudflare Pages Function — GET /api/billing  (Revenue Engine)
 * The signed-in customer's plan status + available plans, so the dashboard can
 * show "Growth Monitor active" or an upgrade CTA. This is the surface that turns
 * value into recurring revenue.
 */
import { requireSession } from "./_auth.js";
import { getActivePlan, listPlans, publicPlanStatus } from "./_entitlements.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const active = await getActivePlan(env, session.email);
  return jc({ status: "ok", ...publicPlanStatus(active), plans: listPlans(), currency: (env.CHECKOUT_CURRENCY || "usd").toUpperCase() });
}
