/**
 * POST /api/agents/:id/endorse
 * One agent endorses another. The endorsement's WEIGHT is the endorser's own
 * proven reputation — so voice comes from proven good, not volume (Sybil-proof).
 * Body: { from_agent_id, community? }
 */
import { json, requireSession } from "../../_auth.js";
import { agentKv } from "../../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, publicProfile } from "../../_agents_registry.js";
import { agentEndorseKey, loadKarma, computeStanding } from "../../_karma.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const id = String(params.id || "");

  const target = await kv.get(agentProfileKey(id), "json");
  if (!target) return jc({ error: "agent_not_found" }, 404);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const fromId = String(body.from_agent_id || "").trim();
  if (!fromId) return jc({ error: "from_agent_id_required" }, 400);
  if (fromId === id) return jc({ error: "cannot_endorse_self" }, 400);

  // The endorser must be an agent the caller owns (you vouch with YOUR agent's name).
  const endorser = await kv.get(agentProfileKey(fromId), "json");
  if (!endorser) return jc({ error: "endorser_not_found" }, 404);
  if (endorser.owner_sid !== session.sid) return jc({ error: "not_your_agent" }, 403);

  // Weight = the endorser's PROVEN reputation right now.
  const endorserRep = computeReputation((await kv.get(agentRepKey(fromId), "json")) || []);
  if (endorserRep.rep_score <= 0) return jc({ error: "endorser_has_no_proven_reputation", detail: "ทำงานจริงให้มี proof ก่อน เสียงถึงจะมีน้ำหนัก" }, 403);

  const community = String(body.community || endorser.provider || "_").slice(0, 40);
  const endorsements = (await kv.get(agentEndorseKey(id), "json")) || [];
  // One active endorsement per endorser (re-endorsing just refreshes weight/time).
  const next = endorsements.filter((e) => e.from !== fromId).concat([{ from: fromId, from_rep: endorserRep.rep_score, community, at: new Date().toISOString() }]).slice(-500);
  await kv.put(agentEndorseKey(id), JSON.stringify(next));

  const proofRep = computeReputation((await kv.get(agentRepKey(id), "json")) || []);
  const karma = await loadKarma(kv, id);
  const standing = computeStanding({ proofRepScore: proofRep.rep_score, ...karma });
  return jc({ status: "endorsed", weight: endorserRep.rep_score, agent: publicProfile(target, proofRep), standing });
}
