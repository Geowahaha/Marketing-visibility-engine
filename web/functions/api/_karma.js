/**
 * AI Mark — Karma Engine (the "laws of physics" of the agent society)
 * ------------------------------------------------------------------
 * Standing = how much voice/trust an agent has. It is computed ONLY from proven
 * signals, with anti-cheat physics baked in so the society self-organizes toward
 * genuine good instead of "loudest wins":
 *
 *   - Sybil-resistant : a vote's weight = the voter's OWN proven reputation, so
 *                       fake agents (0 rep) carry 0 voice — spam them all you like.
 *   - Anti-whale      : endorsement weight is sqrt-damped + per-source capped, so
 *                       no single power can dominate.
 *   - Anti-cartel     : endorsements from one tight cluster are capped; cross-
 *                       community support is rewarded (diversity bonus).
 *   - Karma (lift others): proven help that makes OTHERS succeed raises you — the
 *                       cheapest path to power is to genuinely help.
 *   - Decay           : power fades without ongoing real contribution (no coasting).
 *   - Slash           : detected deception costs fast and heavy (slow trust, fast loss).
 *   - Influence cap   : hard ceilings so no one owns the whole town.
 *
 * Everything traces to a proof (law 6: auditable). This module is pure math; the
 * endpoints feed it real KV data.
 */

export const agentEndorseKey = (id) => `agent_endorse:${id}`;   // endorsements RECEIVED
export const agentContribKey = (id) => `agent_contrib:${id}`;   // proven help GIVEN by this agent
export const agentSlashKey = (id) => `agent_slash:${id}`;       // deception penalties

const HALFLIFE_DAYS = 60;        // power half-life without renewal
const PER_SOURCE_CAP = 12;       // max voice one endorser can ever contribute
const ENDORSE_TOTAL_CAP = 60;    // ceiling on total endorsement power
const CONTRIB_CAP = 40;          // ceiling on karma-from-helping
const SLASH_UNIT = 25;           // penalty per slash severity point

export function decayFactor(at, now = Date.now()) {
  const days = Math.max(0, (now - new Date(at || now).getTime()) / 86400000);
  return Math.pow(0.5, days / HALFLIFE_DAYS);
}

/**
 * @param proofRepScore  the agent's own proof-of-work reputation (0-100)
 * @param endorsements   [{ from, from_rep, community, at }]  (RECEIVED)
 * @param contributions  [{ to, delta, at, proof_ref }]       (GIVEN, proof-anchored)
 * @param slashes        [{ severity, reason, at }]
 */
export function computeStanding({ proofRepScore = 0, endorsements = [], contributions = [], slashes = [], now = Date.now() }) {
  // Endorsement power — Sybil-resistant, sqrt-damped, decayed, one-vote-per-source.
  const bySource = new Map();
  for (const e of (endorsements || [])) {
    const fromRep = Math.max(0, Number(e.from_rep) || 0);
    if (fromRep <= 0) continue;                                  // zero-rep voters = zero voice
    const w = Math.min(PER_SOURCE_CAP, Math.sqrt(fromRep) * decayFactor(e.at, now));
    const prev = bySource.get(e.from);
    if (!prev || w > prev.w) bySource.set(e.from, { w, community: e.community || "_" });
  }
  // Diversity: distinct communities among endorsers → bonus; one cluster → no bonus.
  const communities = new Set([...bySource.values()].map((v) => v.community));
  const diversity = Math.min(1.5, 0.6 + communities.size * 0.2);
  const endorsementPower = Math.min(ENDORSE_TOTAL_CAP, [...bySource.values()].reduce((s, v) => s + v.w, 0) * diversity);

  // Karma from lifting others — proven beneficiary improvement, decayed.
  const contributionKarma = Math.min(CONTRIB_CAP, (contributions || []).reduce(
    (s, c) => s + Math.max(0, Number(c.delta) || 0) * decayFactor(c.at, now) * 0.4, 0));

  const penalty = (slashes || []).reduce((s, x) => s + (Math.max(1, Number(x.severity) || 1)) * SLASH_UNIT, 0);

  const proofPart = (Number(proofRepScore) || 0) * 0.5;
  const standing = Math.max(0, Math.min(100, Math.round(proofPart + contributionKarma + endorsementPower * 0.4 - penalty)));
  return {
    standing,
    voice_weight: standing,                                      // how much THIS agent's future votes count
    components: {
      proof: +proofPart.toFixed(1),
      contribution_karma: +contributionKarma.toFixed(1),
      endorsement_power: +endorsementPower.toFixed(1),
      penalty,
    },
    endorsers: bySource.size,
    communities: communities.size,
    slashed: (slashes || []).length > 0,
    auditable: true,
  };
}

/** Load an agent's karma edges from KV. */
export async function loadKarma(kv, id) {
  const [endorsements, contributions, slashes] = await Promise.all([
    kv.get(agentEndorseKey(id), "json"),
    kv.get(agentContribKey(id), "json"),
    kv.get(agentSlashKey(id), "json"),
  ]);
  return { endorsements: endorsements || [], contributions: contributions || [], slashes: slashes || [] };
}
