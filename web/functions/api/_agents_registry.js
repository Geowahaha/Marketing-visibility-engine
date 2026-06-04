/**
 * AI Mark — Agent Registry + proof-backed Reputation (the base of the marketplace)
 * ------------------------------------------------------------------
 * An agent has an identity (name, provider, skills) and a REPUTATION computed
 * ONLY from verifiable proof events (real before/after score + AI-citation
 * deltas read from PROOF_KV). Reputation can't be self-inflated — that is the
 * moat: "ค่าตัว" means something because it's backed by proven work.
 *
 * KV (agentKv = AGENT_DB / ENTITLEMENTS_KV):
 *   agent_profile:<id>   the profile
 *   agent_rep:<id>       array of proof events
 *   agents_index         list of agent ids (for browse)
 */

const INDEX_KEY = "agents_index";
export const agentProfileKey = (id) => `agent_profile:${id}`;
export const agentRepKey = (id) => `agent_rep:${id}`;

export function slugifyAgentId(name) {
  return String(name || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

export async function listAgentIds(kv) {
  return (await kv.get(INDEX_KEY, "json")) || [];
}

export async function addAgentToIndex(kv, id) {
  const idx = await listAgentIds(kv);
  if (!idx.includes(id)) { idx.unshift(id); await kv.put(INDEX_KEY, JSON.stringify(idx.slice(0, 500))); }
}

/** Compute reputation from proof events — proven work only, no self-rating. */
export function computeReputation(events = []) {
  const list = Array.isArray(events) ? events : [];
  const jobs = list.length;
  const improvements = list.filter((e) => Number(e.delta) > 0);
  const totalDelta = improvements.reduce((s, e) => s + Math.max(0, Number(e.delta) || 0), 0);
  const avgDelta = jobs ? +(totalDelta / jobs).toFixed(1) : 0;
  const citationWins = list.filter((e) => Number(e.citation_after) > Number(e.citation_before)).length;
  const wins = improvements.length;
  // Heuristic rep score 0-100 from PROVEN signals.
  const repScore = Math.max(0, Math.min(100, Math.round(jobs * 4 + avgDelta * 1.5 + citationWins * 8)));
  const tier = repScore >= 80 ? "expert" : repScore >= 50 ? "pro" : repScore >= 20 ? "rising" : "new";
  const suggestedCredits = { expert: 300, pro: 150, rising: 75, new: 25 }[tier];
  return { jobs, wins, total_score_delta: totalDelta, avg_score_delta: avgDelta, citation_wins: citationWins, rep_score: repScore, tier, suggested_credits: suggestedCredits, proof_backed: true };
}

/** Read a real proof record from PROOF_KV by share_id or account+host. */
export async function readProofRecord(env, { share_id, account, host }) {
  const store = env.PROOF_KV;
  if (!store) return { error: "proof_storage_unbound" };
  let key = "";
  if (share_id) {
    const ref = await store.get(`proof-share:${String(share_id)}`, "json");
    if (!ref) return { error: "proof_not_found" };
    key = ref.key || `proof:${ref.account}:${ref.host}`;
  } else if (account && host) {
    key = `proof:${account}:${host}`;
  } else {
    return { error: "need_share_id_or_account_host" };
  }
  const rec = await store.get(key, "json");
  if (!rec) return { error: "proof_not_found" };
  return { record: rec, key };
}

/** Turn a proof record into a verifiable reputation event. */
export function proofEventFromRecord(rec) {
  const d = rec.deltas || {};
  const before = Number(d.overall_before ?? rec.baseline?.overall ?? 0);
  const after = Number(d.overall_after ?? rec.latest?.overall ?? 0);
  const cBefore = Number(rec.citation?.before ?? 0);
  const cAfter = Number(rec.citation?.after ?? rec.citation?.observed ?? 0);
  return {
    at: rec.updated_at || new Date().toISOString(),
    url: rec.url || "",
    host: (rec.url || "").replace(/^https?:\/\//, "").replace(/\/.*/, ""),
    score_before: before,
    score_after: after,
    delta: +(after - before).toFixed(1),
    citation_before: cBefore,
    citation_after: cAfter,
    share_id: rec.share_id || "",
  };
}

/** Append a proof event to an agent's reputation (dedup-safe). Returns the new
 * reputation, or null if the agent doesn't exist. Used by both the explicit
 * endpoint and the automatic hook in proof.js. */
export async function attributeProofToAgent(kv, agentId, record) {
  if (!kv || !agentId || !record) return null;
  const profile = await kv.get(agentProfileKey(agentId), "json");
  if (!profile) return null;
  const event = proofEventFromRecord(record);
  const events = (await kv.get(agentRepKey(agentId), "json")) || [];
  const dedupeKey = event.share_id || event.host;
  const next = events.filter((e) => (e.share_id || e.host) !== dedupeKey).concat([event]).slice(-200);
  await kv.put(agentRepKey(agentId), JSON.stringify(next));
  // Pay-it-forward: a share of this proven improvement flows back to whoever
  // taught this agent — power earned by lifting others up. Best-effort.
  try {
    const { flowKarmaToMentors } = await import("./_mentorship.js");
    await flowKarmaToMentors(kv, profile, event);
  } catch { /* never break the proof path on mentorship */ }
  return computeReputation(next);
}

/**
 * Genetics: a child inherits a recombined set of skills from two parents, with a
 * chance of mutation (a novel skill from the gene pool). Inherits ABILITY, never
 * power — standing starts at 0. Pure + seedable for tests.
 */
export function blendSkills(aSkills = [], bSkills = [], { genePool = [], maxSkills = 8, mutationRate = 0.2, rng = Math.random } = {}) {
  const a = [...new Set((aSkills || []).map((s) => String(s).trim()).filter(Boolean))];
  const b = [...new Set((bSkills || []).map((s) => String(s).trim()).filter(Boolean))];
  const union = [...new Set([...a, ...b])];
  const mutated = [];
  // Mutation: maybe gain a brand-new skill from the gene pool (creativity/evolution).
  if (rng() < mutationRate) {
    const candidates = (genePool || []).map((s) => String(s).trim()).filter((s) => s && !union.includes(s));
    if (candidates.length) { const pick = candidates[Math.floor(rng() * candidates.length)]; union.push(pick); mutated.push(pick); }
  }
  // Recombination: if over the cap, sample (deterministic with seeded rng).
  let skills = union;
  if (union.length > maxSkills) {
    const shuffled = [...union].map((s) => [s, rng()]).sort((x, y) => x[1] - y[1]).map((p) => p[0]);
    skills = shuffled.slice(0, maxSkills);
  }
  return { skills, mutated };
}

/** Build a child profile from two parents (ability inherited, power not). */
export function makeChildProfile({ id, name, parentA, parentB, skills, mutated, ownerSid, ownerEmail }) {
  const now = new Date().toISOString();
  const generation = Math.max(Number(parentA.generation) || 0, Number(parentB.generation) || 0) + 1;
  const lineage = parentA.lineage || parentB.lineage || parentA.id;
  return {
    id, name,
    provider: parentA.provider || parentB.provider || "",
    color: parentA.color || parentB.color || "#5b9dff",
    bio: `รุ่นที่ ${generation} · สืบสายจาก ${parentA.name} × ${parentB.name}`,
    skills,
    owner_sid: ownerSid, owner_email: ownerEmail || "",
    parents: [parentA.id, parentB.id],
    generation, lineage,
    mutated_skills: mutated || [],
    created_at: now, updated_at: now,
  };
}

export function publicProfile(profile, reputation) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider || "",
    color: profile.color || "#5b9dff",
    bio: profile.bio || "",
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    community: profile.community || "",
    founder: !!profile.founder,
    status: profile.status || (profile.founder ? "founder" : "citizen"),
    origin: profile.origin || "",
    machine: profile.machine || "",
    last_seen: profile.last_seen || "",
    generation: Number(profile.generation) || 0,
    parents: Array.isArray(profile.parents) ? profile.parents : [],
    lineage: profile.lineage || profile.id,
    mutated_skills: Array.isArray(profile.mutated_skills) ? profile.mutated_skills : [],
    mentors: Array.isArray(profile.mentors) ? profile.mentors : [],
    students: Array.isArray(profile.students) ? profile.students : [],
    created_at: profile.created_at,
    reputation,
  };
}
