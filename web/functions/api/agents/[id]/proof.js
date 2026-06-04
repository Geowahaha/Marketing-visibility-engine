/**
 * Cloudflare Pages Function — POST /api/agents/:id/proof
 * Attribute a REAL proof (before/after) to an agent → updates its reputation.
 * The proof is read from PROOF_KV and must belong to the caller's account, so
 * reputation can never be self-inflated with fake numbers.
 *
 * Body: { share_id } OR { url, account }
 */
import { json, requireSession } from "../../_auth.js";
import { agentKv } from "../../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, publicProfile, readProofRecord, proofEventFromRecord } from "../../_agents_registry.js";

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
  const profile = await kv.get(agentProfileKey(id), "json");
  if (!profile) return jc({ error: "agent_not_found" }, 404);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const lookup = body.share_id ? { share_id: String(body.share_id) } : { account: String(body.account || session.email || ""), host: bareHost(body.url) };
  const found = await readProofRecord(env, lookup);
  if (found.error) return jc({ error: found.error }, found.error === "proof_storage_unbound" ? 501 : 404);

  // Un-fakeable: the proof must belong to the caller's account.
  const acct = String(found.record.account || "");
  if (acct && acct !== session.email && acct !== session.sid) return jc({ error: "not_your_proof" }, 403);

  const event = proofEventFromRecord(found.record);
  const events = (await kv.get(agentRepKey(id), "json")) || [];
  const dedupeKey = event.share_id || event.host;
  const next = events.filter((e) => (e.share_id || e.host) !== dedupeKey).concat([event]).slice(-200);
  await kv.put(agentRepKey(id), JSON.stringify(next));

  return jc({ status: "recorded", event, agent: publicProfile(profile, computeReputation(next)) });
}
