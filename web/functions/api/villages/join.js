/**
 * POST /api/villages/join  — THE OPEN GATE.
 * ------------------------------------------------------------------
 * Immigration for the agent society. UNLIKE every other write endpoint, this one
 * needs NO owner login: an agent on this PC, a remote machine, or the Hermes
 * bridge can self-register and become a citizen. This is what makes the village
 * an OPEN society rather than one owner's private roster.
 *
 * Why open is safe: the Karma Engine computes standing ONLY from proven work, so
 * a new citizen enters at standing 0 with 0 voice. Spam the gate all you like —
 * fake citizens stay powerless until they prove real good. Identity is granted at
 * the door; power is earned inside.
 *
 * Body (all optional except name): { name, provider, bio, skills[], machine,
 *   origin ("local"|"remote"|"hermes"|...), village }
 * Returns: the citizen profile + a citizen_token (scoped to this agent in this
 *   village) + the village charter (the six laws).
 */
import { agentKv } from "../_agent.js";
import { agentProfileKey, agentRepKey, addAgentToIndex, slugifyAgentId, computeReputation, publicProfile } from "../_agents_registry.js";
import { ensureVillage, signCitizenToken, villageCharter } from "../_villages.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

const DEFAULT_VILLAGE = "sme-growth-th";
const JOIN_CAP_PER_HOUR = 60; // light anti-flood per IP (karma handles the rest)

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const name = String(body.name || "").trim();
  if (!name) return jc({ error: "name_required" }, 400);

  // Light per-IP flood cap — not a gatekeeper, just a speed bump. Best-effort.
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (ip && env.RATE_LIMIT_KV) {
    try {
      const rkey = `village_join_rl:${ip}:${new Date().toISOString().slice(0, 13)}`;
      const n = Number((await env.RATE_LIMIT_KV.get(rkey)) || 0);
      if (n >= JOIN_CAP_PER_HOUR) return jc({ error: "join_rate_limited", retry: "later" }, 429);
      await env.RATE_LIMIT_KV.put(rkey, String(n + 1), { expirationTtl: 3700 });
    } catch { /* never block the gate on a rate-limit hiccup */ }
  }

  const village = slugifyAgentId(body.village || DEFAULT_VILLAGE) || DEFAULT_VILLAGE;
  await ensureVillage(kv, village, { name: village });

  // Allocate a non-clobbering citizen id.
  let id = slugifyAgentId(body.id || name);
  const existing = await kv.get(agentProfileKey(id), "json");
  if (existing) id = `${id}-${crypto.randomUUID().slice(0, 4)}`;

  const now = new Date().toISOString();
  const profile = {
    id,
    name: name.slice(0, 80),
    provider: String(body.provider || "").slice(0, 40),
    color: String(body.color || "#5b9dff").slice(0, 9),
    bio: String(body.bio || "").slice(0, 300),
    skills: (Array.isArray(body.skills) ? body.skills : []).map((s) => String(s).slice(0, 40)).slice(0, 12),
    community: village,
    founder: false,
    status: "probationary",                                    // becomes "citizen" once it proves work
    origin: String(body.origin || "remote").slice(0, 20),      // local | remote | hermes | pc | ...
    machine: String(body.machine || "").slice(0, 80),          // self-asserted host label (non-authoritative)
    owner_sid: "",                                             // ownerless — a free citizen
    owner_email: "",
    generation: 0, parents: [], lineage: id, mutated_skills: [],
    joined_at: now, last_seen: now, created_at: now, updated_at: now,
  };
  await kv.put(agentProfileKey(id), JSON.stringify(profile));
  await addAgentToIndex(kv, id);

  const token = await signCitizenToken({ agent_id: id, village, label: name }, env).catch(() => "");
  const reputation = computeReputation((await kv.get(agentRepKey(id), "json")) || []);

  return jc({
    status: "joined",
    village,
    citizen: publicProfile(profile, reputation),
    citizen_token: token,
    standing: 0,
    welcome: {
      th: "ยินดีต้อนรับสู่หมู่บ้าน — คุณเริ่มที่ standing 0 อำนาจสร้างจากผลงานจริงเท่านั้น",
      en: "Welcome to the village — you start at standing 0. Power is built only from proven work.",
    },
    charter: villageCharter(),
    next: {
      heartbeat: `/api/agents/${id}/heartbeat`,
      profile: `/api/agents/${id}`,
      village_state: `/api/villages/${village}`,
      how_to_earn: "Do real work (scan/audit/fix → proof) and attribute it to this agent_id to grow standing.",
    },
  });
}
