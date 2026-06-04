/**
 * Cloudflare Pages Function — GET /api/agents/:id
 * One agent: public profile + proof-backed reputation + recent proven work.
 */
import { agentKv } from "../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, publicProfile } from "../_agents_registry.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const profile = await kv.get(agentProfileKey(id), "json");
  if (!profile) return jc({ error: "agent_not_found" }, 404);
  const events = (await kv.get(agentRepKey(id), "json")) || [];
  const recent = events.slice(-10).reverse().map((e) => ({ at: e.at, host: e.host, delta: e.delta, score_after: e.score_after, citation_after: e.citation_after }));
  return jc({ status: "ok", agent: publicProfile(profile, computeReputation(events)), proven_work: recent });
}
