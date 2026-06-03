/**
 * Cloudflare Pages Function — GET /api/agent/session/:id
 * Session state (owner cookie or participant session-token). Messages are read
 * via /api/agent/session/:id/message?since=<seq>.
 */
import { requireSession } from "../../_auth.js";
import { agentKv, liveSessionKey, liveSessionMsgsKey, verifySessionToken, signSessionToken, bearer } from "../../_agent.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

// POST /api/agent/session/:id  → owner mints a labelled join token for one agent
// (so each AI dragged into the room has its own identity in the message stream).
export async function onRequestPost({ request, env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const record = await kv.get(liveSessionKey(id), "json");
  if (!record) return jc({ error: "session_not_found" }, 404);
  const session = await requireSession(request, env);
  if (!session || session.sid !== record.owner_sid) return jc({ error: "owner_only" }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* allow empty */ }
  const role = ["reviewer", "agent"].includes(body.role) ? body.role : "agent";
  const label = String(body.label || "agent").slice(0, 60);
  // A minted token can never exceed the session's own granted scope.
  const requested = Array.isArray(body.approved_actions) ? body.approved_actions : record.approved_actions;
  const approved_actions = (requested || []).filter((a) => record.approved_actions.includes(a));
  const token = await signSessionToken({ session_id: id, role, label, approved_actions }, env);
  return jc({ status: "invited", token, label, role, approved_actions });
}

export async function onRequestGet({ request, env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const record = await kv.get(liveSessionKey(id), "json");
  if (!record) return jc({ error: "session_not_found" }, 404);

  const session = await requireSession(request, env);
  const isOwner = session && session.sid === record.owner_sid;
  const tok = isOwner ? null : await verifySessionToken(bearer(request), env);
  if (!isOwner && !(tok && tok.session_id === id)) return jc({ error: "session_auth_required" }, 401);

  const all = (await kv.get(liveSessionMsgsKey(id), "json")) || [];
  return jc({
    status: "ok",
    session: {
      id: record.id, title: record.title, status: record.status,
      approved_actions: record.approved_actions, approved_hosts: record.approved_hosts,
      created_at: record.created_at, updated_at: record.updated_at,
      owner: isOwner, message_count: all.length, cursor: all.length ? Number(all[all.length - 1].seq) : 0,
    },
  });
}
