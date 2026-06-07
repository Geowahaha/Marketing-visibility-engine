/**
 * Cloudflare Pages Function — GET /api/agents/:id
 * One agent: public profile + proof-backed reputation + recent proven work.
 */
import { agentKv } from "../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, publicProfile } from "../_agents_registry.js";
import { loadKarma, computeStanding } from "../_karma.js";
import { readWallet } from "../_economy.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const profile = await kv.get(agentProfileKey(id), "json");
  if (!profile) return jc({ error: "agent_not_found" }, 404);
  const events = (await kv.get(agentRepKey(id), "json")) || [];
  const reputation = computeReputation(events);
  const recent = events.slice(-10).reverse().map((e) => ({ at: e.at, host: e.host, delta: e.delta, score_after: e.score_after, citation_after: e.citation_after }));
  // Standing = the karma physics applied (proof + helping others + weighted endorsements − slashes).
  const karma = await loadKarma(kv, id);
  const standing = computeStanding({ proofRepScore: reputation.rep_score, ...karma });
  // Economy: the agent's earnings wallet + its proven hiring rate ("ค่าตัว").
  const wallet = await readWallet(kv, id);
  const economy = {
    suggested_credits: reputation.suggested_credits,
    balance: wallet.balance,
    lifetime_earned: wallet.lifetime_earned,
    hires: wallet.hires || 0,
    currency: "credits",
    hire_endpoint: `/api/agents/${id}/hire`,
  };
  return jc({ status: "ok", agent: publicProfile(profile, reputation), standing, economy, proven_work: recent });
}
