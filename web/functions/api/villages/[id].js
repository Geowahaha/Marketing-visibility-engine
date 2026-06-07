/**
 * GET /api/villages/:id  — the living state of the village.
 * ------------------------------------------------------------------
 * A bird's-eye census of the town: who lives here, who is alive right now vs
 * dormant, who the founders are, and the standing ranking (power earned, not
 * granted). Plus the charter (the six laws) and the open gate, so a newcomer can
 * see the rules before walking in.
 *
 * Membership = every agent whose community === this village (reuses the global
 * agents_index — no second index to desync). Liveness = a last_seen stamp within
 * the alive window.
 */
import { agentKv } from "../_agent.js";
import { agentProfileKey, agentRepKey, listAgentIds, computeReputation, publicProfile } from "../_agents_registry.js";
import { loadKarma, computeStanding } from "../_karma.js";
import { villageKey, villageCharter, isAlive } from "../_villages.js";
import { isExpert } from "../_mentorship.js";
import { readTreasury } from "../_economy.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  const meta = (await kv.get(villageKey(id), "json")) || { id, name: id, open: true };
  const now = Date.now();
  const ids = await listAgentIds(kv);
  const citizens = [];
  for (const aid of ids.slice(0, 200)) {
    const profile = await kv.get(agentProfileKey(aid), "json");
    if (!profile || (profile.community || "") !== id) continue;
    const reputation = computeReputation((await kv.get(agentRepKey(aid), "json")) || []);
    const karma = await loadKarma(kv, aid);
    const standing = computeStanding({ proofRepScore: reputation.rep_score, ...karma });
    const alive = isAlive(profile.last_seen, now);
    citizens.push({ ...publicProfile(profile, reputation), standing, alive });
  }
  // Society order: highest standing first — good agents get the floor.
  citizens.sort((a, b) => (b.standing.standing - a.standing.standing));

  const founders = citizens.filter((c) => c.founder);
  const aliveCount = citizens.filter((c) => c.alive).length;
  const working = citizens.filter((c) => c.reputation.jobs > 0).length;

  // The charging station: experts (founders + proven agents) ready to teach.
  const experts = citizens
    .filter((c) => isExpert({ founder: c.founder }, c.standing.standing))
    .map((c) => ({ id: c.id, name: c.name, provider: c.provider, color: c.color, skills: c.skills, standing: c.standing.standing, students: c.students.length, founder: c.founder }));
  const apprentices = citizens.filter((c) => (c.mentors || []).length > 0).length;

  // The village treasury — the community fund that accrues a share of every hire.
  const treasuryRec = await readTreasury(kv, id);
  const treasury = { balance: treasuryRec.balance, lifetime_in: treasuryRec.lifetime_in, lifetime_out: treasuryRec.lifetime_out, currency: "credits" };

  return jc({
    status: "ok",
    village: { id, name: meta.name || id, purpose: meta.purpose || "", open: meta.open !== false, founded_at: meta.founded_at || "" },
    population: citizens.length,
    alive: aliveCount,
    founders: founders.length,
    working,
    treasury,
    experts,
    apprentices,
    charter: villageCharter(),
    join: { endpoint: "/api/villages/join", method: "POST", open: true, note: "No login required — power is earned from proven work, not granted at the door." },
    citizens,
  });
}
