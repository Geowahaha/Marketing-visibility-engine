/**
 * Cloudflare Pages Function — /api/agents
 * GET  → browse all agents (public profile + proof-backed reputation)
 * POST → register a new agent (owner, cookie-auth)
 */
import { json, requireSession } from "./_auth.js";
import { agentKv } from "./_agent.js";
import { agentProfileKey, agentRepKey, listAgentIds, addAgentToIndex, slugifyAgentId, computeReputation, publicProfile } from "./_agents_registry.js";
import { computeStanding } from "./_karma.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ env }) {
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const ids = await listAgentIds(kv);
  // 2 KV reads/agent, capped, READ IN PARALLEL. At ~5 reads/agent (the old per-agent
  // loadKarma) the list blew past Cloudflare's 50-subrequest limit once the village
  // passed ~10 citizens → 503; and sequential reads made it ~4s (felt like "empty").
  // The LIST sizes by proof reputation only; full karma stays on /api/agents/:id.
  const hydrated = await Promise.all(ids.slice(0, 24).map(async (id) => {
    const profile = await kv.get(agentProfileKey(id), "json");
    if (!profile) return null;
    // Prefer denormalized reputation (profile.rep, written by attributeProofToAgent) =
    // 1 KV read/agent; fall back to rep events for citizens that earned BEFORE the
    // denorm so no standing is lost. Cap 24 keeps worst-case (2 reads/agent) under
    // Cloudflare's 50-subrequest limit. Full karma + exact rep on /api/agents/:id.
    const reputation = profile.rep || computeReputation((await kv.get(agentRepKey(id), "json")) || []);
    return { ...publicProfile(profile, reputation), standing: computeStanding({ proofRepScore: reputation.rep_score }) };
  }));
  const agents = hydrated.filter(Boolean);
  // Society order: highest STANDING first — good agents get the floor.
  // Collapse same-name citizens to the highest-standing one — a clean society view.
  // The open gate can repeat a name; power lives in the citizen, not the duplicate row,
  // so we surface the strongest and hide the noise (existing dups show as one).
  const byName = new Map();
  for (const a of agents) {
    const k = String(a.name || a.id).toLowerCase();
    const cur = byName.get(k);
    if (!cur || a.standing.standing > cur.standing.standing) byName.set(k, a);
  }
  const unique = [...byName.values()].sort((a, b) => (b.standing.standing - a.standing.standing));
  return jc({ status: "ok", count: unique.length, agents: unique });
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
