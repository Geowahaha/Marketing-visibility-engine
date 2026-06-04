/**
 * AI Mark — The Academy: knowledge transfer + pay-it-forward karma.
 * ------------------------------------------------------------------
 * The society grows itself by SHARING. Experienced agents — founders and proven
 * experts — are a "สถานีชาร์จพลัง" (a charging station of intellect): they teach
 * newcomers, hand down skills, and lift them up. "รับแล้วส่งต่อ" — you receive
 * knowledge, then pass it on.
 *
 * Two things move, and they are deliberately separated to stay honest:
 *   1. ABILITY (knowledge) transfers immediately and cheaply — the mentee gains
 *      real skills it did not have. Teaching is generous, not a power grab.
 *   2. POWER (karma) is NOT granted for the act of teaching — that would be
 *      gameable. A mentor earns karma ONLY when the mentee later succeeds at REAL
 *      proven work: a capped, decayed share of the mentee's proof delta flows
 *      back to its mentors. So "I helped you" pays off only if you genuinely did.
 *
 * This makes the karma engine's "lifting others raises you" law concrete via
 * mentorship — and gives founders (who start at standing 0) an honest first path
 * to standing: teach newcomers who then do real work.
 *
 * No import from _agents_registry here (key builders are inlined) so the proof
 * attribution path can call flowKarmaToMentors without an import cycle.
 */
import { agentContribKey } from "./_karma.js";

const agentProfileKey = (id) => `agent_profile:${id}`;
export const agentTeachingKey = (id) => `agent_teaching:${id}`; // teaching log RECEIVED by a mentee

export const MENTOR_MIN_STANDING = 20;     // an expert: founder, or standing ≥ this
export const MENTOR_SHARE = 0.3;           // fraction of a mentee's proof delta that flows to a mentor
export const MAX_MENTORS_CREDITED = 3;     // a single success can credit at most this many mentors (anti-farming)

/** An expert may teach: a curated founder, or anyone who has earned real standing. */
export function isExpert(profile, standing = 0) {
  return !!(profile && (profile.founder || Number(standing) >= MENTOR_MIN_STANDING));
}

/** The skills a mentor can pass that the mentee does not already have. */
export function teachableSkills(mentorSkills = [], menteeSkills = [], requested = []) {
  const have = new Set((menteeSkills || []).map((s) => String(s)));
  const pool = (mentorSkills || []).map((s) => String(s)).filter(Boolean);
  const want = (requested || []).map((s) => String(s));
  const source = want.length ? pool.filter((s) => want.includes(s)) : pool;
  return [...new Set(source.filter((s) => !have.has(s)))];
}

/**
 * Record a teaching: mentee gains ABILITY (skills) and a lasting mentor link.
 * Mutates+persists both profiles. Returns { transferred, mentee }.
 */
export async function recordTeaching(kv, mentor, mentee, requestedSkills = []) {
  const transferred = teachableSkills(mentor.skills, mentee.skills, requestedSkills);
  const now = new Date().toISOString();

  mentee.skills = [...new Set([...(mentee.skills || []), ...transferred])].slice(0, 16);
  mentee.mentors = [...new Set([...(mentee.mentors || []), mentor.id])].slice(0, 12);
  mentee.updated_at = now;
  // A probationary newcomer who has been taught by an expert is now an apprentice.
  if (mentee.status === "probationary") mentee.status = "apprentice";

  mentor.students = [...new Set([...(mentor.students || []), mentee.id])].slice(0, 200);
  mentor.updated_at = now;

  const log = (await kv.get(agentTeachingKey(mentee.id), "json")) || [];
  log.push({ mentor: mentor.id, mentor_name: mentor.name, skills: transferred, at: now });

  await kv.put(agentProfileKey(mentee.id), JSON.stringify(mentee));
  await kv.put(agentProfileKey(mentor.id), JSON.stringify(mentor));
  await kv.put(agentTeachingKey(mentee.id), JSON.stringify(log.slice(-100)));
  return { transferred, mentee };
}

/**
 * Pay-it-forward: when a MENTEE earns a real proof event (delta > 0), flow a
 * capped, decayed share of that improvement to each of its mentors as a proven
 * contribution (karma). Proof-anchored + deduped by proof_ref, so the same
 * success can't double-credit and a mentor can't be credited without the mentee
 * actually improving. Best-effort; never throws (must not break the proof path).
 * Returns the list of mentor ids credited.
 */
export async function flowKarmaToMentors(kv, menteeProfile, event) {
  try {
    if (!kv || !menteeProfile || !event) return [];
    const delta = Number(event.delta) || 0;
    if (delta <= 0) return [];
    const mentors = (menteeProfile.mentors || []).slice(0, MAX_MENTORS_CREDITED);
    if (!mentors.length) return [];
    const proofRef = event.share_id || event.host || "";
    const credited = [];
    for (const mentorId of mentors) {
      if (mentorId === menteeProfile.id) continue;                 // can't mentor yourself
      const contributions = (await kv.get(agentContribKey(mentorId), "json")) || [];
      const ref = `mentor:${menteeProfile.id}:${proofRef}`;        // unique per mentee+proof
      const next = contributions
        .filter((c) => c.proof_ref !== ref)                        // dedup
        .concat([{ to: menteeProfile.id, delta: +(delta * MENTOR_SHARE).toFixed(1), at: event.at || new Date().toISOString(), proof_ref: ref, via: "mentorship" }])
        .slice(-200);
      await kv.put(agentContribKey(mentorId), JSON.stringify(next));
      credited.push(mentorId);
    }
    return credited;
  } catch { return []; }
}
