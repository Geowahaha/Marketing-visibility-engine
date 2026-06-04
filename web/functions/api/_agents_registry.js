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

export function publicProfile(profile, reputation) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider || "",
    color: profile.color || "#5b9dff",
    bio: profile.bio || "",
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    created_at: profile.created_at,
    reputation,
  };
}
