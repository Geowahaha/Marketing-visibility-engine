/**
 * POST /api/agents/:id/reproduce
 * Two agents have a child. The child inherits a recombined (+ maybe mutated) set
 * of skills from both parents — but NOT their standing: every generation earns
 * its own place (no dynasties). Lineage must be earned: at least one parent must
 * have done real proven work, so the family tree can't be Sybil-spammed.
 * Body: { partner_id, child_name }
 */
import { json, requireSession } from "../../_auth.js";
import { agentKv } from "../../_agent.js";
import { agentProfileKey, agentRepKey, slugifyAgentId, addAgentToIndex, blendSkills, makeChildProfile, computeReputation, publicProfile } from "../../_agents_registry.js";
import { listSkills } from "../../_skills.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  const aId = String(params.id || "");
  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const bId = String(body.partner_id || "").trim();
  if (!bId || bId === aId) return jc({ error: "need_distinct_partner_id" }, 400);

  const [parentA, parentB] = await Promise.all([kv.get(agentProfileKey(aId), "json"), kv.get(agentProfileKey(bId), "json")]);
  if (!parentA || !parentB) return jc({ error: "parent_not_found" }, 404);
  // You breed your own line (cross-owner mating with consent comes later).
  if (parentA.owner_sid !== session.sid || parentB.owner_sid !== session.sid) return jc({ error: "not_your_agents" }, 403);

  // Earned lineage: at least one parent must have proven real work (anti-Sybil).
  const [repA, repB] = await Promise.all([
    computeReputation((await kv.get(agentRepKey(aId), "json")) || []),
    computeReputation((await kv.get(agentRepKey(bId), "json")) || []),
  ]);
  if (repA.jobs <= 0 && repB.jobs <= 0) {
    return jc({ error: "parents_have_no_proven_work", detail: "พ่อแม่อย่างน้อยหนึ่งตัวต้องทำงานจริงให้มี proof ก่อน — สายเลือดต้องหามาด้วยการทำดี" }, 403);
  }

  const childName = String(body.child_name || `${parentA.name}-jr`).slice(0, 60);
  let childId = slugifyAgentId(childName);
  if (await kv.get(agentProfileKey(childId), "json")) childId = `${childId}-${crypto.randomUUID().slice(0, 4)}`;

  const genePool = listSkills().map((s) => s.label || s.id).filter(Boolean);
  const { skills, mutated } = blendSkills(parentA.skills, parentB.skills, { genePool });
  const child = makeChildProfile({ id: childId, name: childName, parentA, parentB, skills, mutated, ownerSid: session.sid, ownerEmail: session.email });

  await kv.put(agentProfileKey(childId), JSON.stringify(child));
  await addAgentToIndex(kv, childId);
  // Record offspring on parents (a sign of nurturing the next generation).
  for (const p of [parentA, parentB]) {
    p.children = [...new Set([...(p.children || []), childId])].slice(0, 100);
    p.updated_at = new Date().toISOString();
    await kv.put(agentProfileKey(p.id), JSON.stringify(p));
  }

  return jc({ status: "born", child: publicProfile(child, computeReputation([])), inherited_skills: skills, mutated_skills: mutated, generation: child.generation });
}
