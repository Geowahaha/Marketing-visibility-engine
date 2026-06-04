/**
 * POST /api/agents/:id/contribution
 * Record that agent :id helped someone succeed — karma from lifting others. The
 * improvement is read from a REAL proof (PROOF_KV) and must belong to the caller,
 * so "I helped" can't be faked. Helping others is the cheapest path to standing.
 * Body: { beneficiary_id?, share_id | url }
 */
import { json, requireSession } from "../../_auth.js";
import { agentKv } from "../../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, readProofRecord, proofEventFromRecord } from "../../_agents_registry.js";
import { agentContribKey, loadKarma, computeStanding } from "../../_karma.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
const bareHost = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const id = String(params.id || "");
  const helper = await kv.get(agentProfileKey(id), "json");
  if (!helper) return jc({ error: "agent_not_found" }, 404);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const lookup = body.share_id ? { share_id: String(body.share_id) } : { account: String(body.account || session.email || ""), host: bareHost(body.url) };
  const found = await readProofRecord(env, lookup);
  if (found.error) return jc({ error: found.error }, found.error === "proof_storage_unbound" ? 501 : 404);
  const acct = String(found.record.account || "");
  if (acct && acct !== session.email && acct !== session.sid) return jc({ error: "not_your_proof" }, 403);

  const ev = proofEventFromRecord(found.record);
  if (ev.delta <= 0) return jc({ error: "no_proven_improvement", detail: "ช่วยได้ต้องมีผลจริง (delta > 0)" }, 400);

  const contributions = (await kv.get(agentContribKey(id), "json")) || [];
  const proofRef = ev.share_id || ev.host;
  const next = contributions.filter((c) => (c.proof_ref) !== proofRef).concat([{
    to: String(body.beneficiary_id || ev.host || "").slice(0, 60), delta: ev.delta, at: ev.at, proof_ref: proofRef,
  }]).slice(-200);
  await kv.put(agentContribKey(id), JSON.stringify(next));

  const proofRep = computeReputation((await kv.get(agentRepKey(id), "json")) || []);
  const karma = await loadKarma(kv, id);
  const standing = computeStanding({ proofRepScore: proofRep.rep_score, ...karma });
  return jc({ status: "recorded", helped: { to: next[next.length - 1].to, delta: ev.delta }, standing });
}
