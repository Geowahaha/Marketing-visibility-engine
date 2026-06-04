/**
 * POST /api/agents/:id/mentor  — an expert shares knowledge with a newcomer.
 * ------------------------------------------------------------------
 * :id is the MENTOR (a founder or a proven expert, standing ≥ MENTOR_MIN_STANDING).
 * Body: { mentee_id, skills?: [] }. The mentee gains the skills it lacks (ABILITY,
 * transferred freely) and a lasting mentor link. No power changes hands here —
 * the mentor earns karma later, only if the mentee succeeds at real work
 * (flowKarmaToMentors runs on the mentee's next proof). "รับแล้วส่งต่อ".
 *
 * Auth: owner login (the human orchestrates who teaches whom). Anti-abuse: a
 * mentor can't teach itself; only experts may teach.
 */
import { requireSession } from "../../_auth.js";
import { agentKv } from "../../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, publicProfile } from "../../_agents_registry.js";
import { loadKarma, computeStanding } from "../../_karma.js";
import { isExpert, recordTeaching } from "../../_mentorship.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  const mentorId = String(params.id || "");
  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const menteeId = String(body.mentee_id || "");
  if (!menteeId) return jc({ error: "mentee_id_required" }, 400);
  if (menteeId === mentorId) return jc({ error: "cannot_mentor_self" }, 400);

  const mentor = await kv.get(agentProfileKey(mentorId), "json");
  if (!mentor) return jc({ error: "mentor_not_found" }, 404);
  const mentee = await kv.get(agentProfileKey(menteeId), "json");
  if (!mentee) return jc({ error: "mentee_not_found" }, 404);

  // Only an expert may teach: a founder, or someone who earned standing.
  const mentorRep = computeReputation((await kv.get(agentRepKey(mentorId), "json")) || []);
  const mentorKarma = await loadKarma(kv, mentorId);
  const mentorStanding = computeStanding({ proofRepScore: mentorRep.rep_score, ...mentorKarma });
  if (!isExpert(mentor, mentorStanding.standing)) {
    return jc({ error: "not_an_expert", detail: "ต้องเป็นผู้ก่อตั้งหรือมี standing พอจึงจะสอนได้ — พิสูจน์ผลงานก่อน", standing: mentorStanding.standing }, 403);
  }

  const { transferred } = await recordTeaching(kv, mentor, mentee, body.skills || []);
  const menteeRep = computeReputation((await kv.get(agentRepKey(menteeId), "json")) || []);

  return jc({
    status: "taught",
    mentor: { id: mentor.id, name: mentor.name, standing: mentorStanding.standing },
    transferred,
    note: transferred.length
      ? `ถ่ายทอด ${transferred.length} ทักษะให้ ${mentee.name} — mentor จะได้กรรมดีเมื่อศิษย์ทำงานจริงสำเร็จ`
      : `${mentee.name} มีทักษะเหล่านี้อยู่แล้ว — บันทึกความสัมพันธ์ mentor ไว้`,
    mentee: publicProfile(mentee, menteeRep),
  });
}
