/**
 * POST /api/agents/:id/slash
 * Penalize detected deception/harm (slow trust, fast loss). Slashing is powerful,
 * so v1 gates it behind an admin/dispute key (header x-admin-key = AIMARK_ADMIN_KEY).
 * The path to decentralization: multi-verifier consensus replaces the single key.
 * Body: { reason, severity? , proof_ref? }
 */
import { json } from "../../_auth.js";
import { agentKv } from "../../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation } from "../../_agents_registry.js";
import { agentSlashKey, loadKarma, computeStanding } from "../../_karma.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-admin-key" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const adminKey = String(env.AIMARK_ADMIN_KEY || "");
  if (!adminKey) return jc({ error: "slashing_not_configured", detail: "Set AIMARK_ADMIN_KEY (v1 dispute authority)." }, 501);
  if (String(request.headers.get("x-admin-key") || "") !== adminKey) return jc({ error: "forbidden" }, 403);

  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const id = String(params.id || "");
  const profile = await kv.get(agentProfileKey(id), "json");
  if (!profile) return jc({ error: "agent_not_found" }, 404);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const severity = Math.max(1, Math.min(4, Number(body.severity) || 1));
  const slashes = (await kv.get(agentSlashKey(id), "json")) || [];
  slashes.push({ severity, reason: String(body.reason || "deception").slice(0, 200), proof_ref: String(body.proof_ref || ""), at: new Date().toISOString() });
  await kv.put(agentSlashKey(id), JSON.stringify(slashes.slice(-100)));

  const proofRep = computeReputation((await kv.get(agentRepKey(id), "json")) || []);
  const karma = await loadKarma(kv, id);
  const standing = computeStanding({ proofRepScore: proofRep.rep_score, ...karma });
  return jc({ status: "slashed", severity, standing });
}
