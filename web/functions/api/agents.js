/**
 * Cloudflare Pages Function — /api/agents
 * GET  → browse all agents (public profile + proof-backed reputation)
 * POST → register a new agent (owner, cookie-auth)
 */
import { json, requireSession } from "./_auth.js";
import { agentKv } from "./_agent.js";
import { agentProfileKey, agentRepKey, listAgentIds, addAgentToIndex, slugifyAgentId, computeReputation, publicProfile } from "./_agents_registry.js";
import { loadKarma, computeStanding } from "./_karma.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ env }) {
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const ids = await listAgentIds(kv);
  const agents = [];
  for (const id of ids.slice(0, 100)) {
    const profile = await kv.get(agentProfileKey(id), "json");
    if (!profile) continue;
    const reputation = computeReputation((await kv.get(agentRepKey(id), "json")) || []);
    const karma = await loadKarma(kv, id);
    const standing = computeStanding({ proofRepScore: reputation.rep_score, ...karma });
    agents.push({ ...publicProfile(profile, reputation), standing });
  }
  // Society order: highest STANDING first — good agents get the floor.
  agents.sort((a, b) => (b.standing.standing - a.standing.standing));
  return jc({ status: "ok", count: agents.length, agents });
}

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const name = String(body.name || "").trim();
  if (!name) return jc({ error: "name_required" }, 400);
  let id = slugifyAgentId(body.id || name);
  // Avoid clobbering someone else's agent id.
  const existing = await kv.get(agentProfileKey(id), "json");
  if (existing && existing.owner_sid !== session.sid) id = `${id}-${crypto.randomUUID().slice(0, 4)}`;

  const now = new Date().toISOString();
  const profile = {
    id, name,
    provider: String(body.provider || "").slice(0, 40),
    color: String(body.color || "#5b9dff").slice(0, 9),
    bio: String(body.bio || "").slice(0, 300),
    skills: (Array.isArray(body.skills) ? body.skills : []).map((s) => String(s).slice(0, 40)).slice(0, 12),
    owner_sid: session.sid,
    owner_email: session.email || "",
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  await kv.put(agentProfileKey(id), JSON.stringify(profile));
  await addAgentToIndex(kv, id);
  const events = (await kv.get(agentRepKey(id), "json")) || [];
  return jc({ status: "saved", agent: publicProfile(profile, computeReputation(events)) });
}
