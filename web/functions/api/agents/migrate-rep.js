/**
 * POST /api/agents/migrate-rep  — one-time Reputation Migration (admin).
 * ------------------------------------------------------------------
 * Backfills the denormalized `profile.rep` onto every agent that earned its
 * reputation BEFORE denormalization existed. Once every agent carries
 * `profile.rep`, the society LIST needs only 1 KV read/agent, which lets the
 * browse cap rise from 24 → 45 while staying under Cloudflare's 50-subrequest
 * cap (free plan).
 *
 * Idempotent + batched: processes up to `limit` agents per call (default 20) and
 * returns a `cursor` to continue. Call repeatedly until `remaining` is 0.
 * Gated by the same admin key as slashing (header x-admin-key = AIMARK_ADMIN_KEY).
 *
 * Body (optional): { limit?, cursor?, force? }
 *   force=true → recompute+rewrite rep even for agents that already have it.
 */
import { agentKv } from "../_agent.js";
import { agentProfileKey, agentRepKey, listAgentIds, computeReputation } from "../_agents_registry.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-admin-key" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 22; // keep worst-case (read events + write)×limit + overhead under 50 subrequests

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const adminKey = String(env.AIMARK_ADMIN_KEY || "");
  if (!adminKey) return jc({ error: "migration_not_configured", detail: "Set AIMARK_ADMIN_KEY to run the reputation migration." }, 501);
  if (String(request.headers.get("x-admin-key") || "") !== adminKey) return jc({ error: "forbidden" }, 403);

  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(body.limit) || DEFAULT_LIMIT));
  const start = Math.max(0, Number(body.cursor) || 0);
  const force = body.force === true;

  const ids = await listAgentIds(kv);
  const batch = ids.slice(start, start + limit);
  let migrated = 0;
  let alreadyHad = 0;
  let missingProfile = 0;

  for (const id of batch) {
    const profile = await kv.get(agentProfileKey(id), "json");
    if (!profile) { missingProfile += 1; continue; }
    if (profile.rep && !force) { alreadyHad += 1; continue; }
    const events = (await kv.get(agentRepKey(id), "json")) || [];
    profile.rep = computeReputation(events);
    profile.updated_at = new Date().toISOString();
    await kv.put(agentProfileKey(id), JSON.stringify(profile));
    migrated += 1;
  }

  const nextCursor = start + batch.length;
  const remaining = Math.max(0, ids.length - nextCursor);
  return jc({
    status: remaining > 0 ? "in_progress" : "done",
    total: ids.length,
    processed: batch.length,
    migrated,
    already_had: alreadyHad,
    missing_profile: missingProfile,
    cursor: nextCursor,
    remaining,
    next: remaining > 0 ? { method: "POST", body: { cursor: nextCursor, limit } } : null,
  });
}
