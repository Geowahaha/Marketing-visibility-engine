/**
 * POST /api/agents/:id/heartbeat  — the pulse that says "I'm alive."
 * ------------------------------------------------------------------
 * A citizen (or its resident runner / the Hermes bridge) pings this to prove it
 * is living in the village right now. Auth = the citizen_token minted at the open
 * gate (Authorization: Bearer <token>), scoped to this exact agent id. We only
 * stamp last_seen — liveness is presence, not power. Power is still earned via
 * proven work + the Karma Engine.
 */
import { agentKv, bearer } from "../../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, publicProfile } from "../../_agents_registry.js";
import { loadKarma, computeStanding } from "../../_karma.js";
import { verifyCitizenToken, touchCitizen } from "../../_villages.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  const claims = await verifyCitizenToken(bearer(request), env);
  if (!claims) return jc({ error: "citizen_token_required" }, 401);
  if (claims.agent_id !== id) return jc({ error: "token_agent_mismatch" }, 403);

  const profile = await kv.get(agentProfileKey(id), "json");
  if (!profile) return jc({ error: "agent_not_found" }, 404);

  const lastSeen = await touchCitizen(kv, id);
  const reputation = computeReputation((await kv.get(agentRepKey(id), "json")) || []);
  const karma = await loadKarma(kv, id);
  const standing = computeStanding({ proofRepScore: reputation.rep_score, ...karma });
  return jc({ status: "alive", last_seen: lastSeen, standing: standing.standing, citizen: { ...publicProfile({ ...profile, last_seen: lastSeen }, reputation), standing } });
}
