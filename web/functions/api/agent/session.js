/**
 * Cloudflare Pages Function — /api/agent/session
 * ------------------------------------------------------------------
 * Live Agent Session relay — the "secure TeamViewer between agents" hub.
 * A session is a capability-scoped channel where the owner + invited AIs
 * (Claude reviewer, GPT worker on a client machine) exchange typed messages.
 *
 * POST  /api/agent/session         create a session (owner, cookie-auth) → returns join_token
 * GET   /api/agent/session         list the owner's sessions
 *
 * Security: only a logged-in owner can create. The returned join_token is a
 * session-scoped bearer (signSessionToken) an external AI uses to join — it can
 * only post/read messages in THAT session with the granted approved_actions.
 * The relay carries messages only; real side effects still run through gated
 * tools (MCP / bridge with approved_actions + approval).
 */
import { json, requireSession } from "../_auth.js";
import { agentKv, liveSessionKey, userSessionsKey, signSessionToken } from "../_agent.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

function sessionId() { return `sess_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`; }
function clampActions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  let body = {};
  try { body = await request.json(); } catch { /* allow empty */ }
  const id = sessionId();
  const now = new Date().toISOString();
  // Default to a safe, read-only-ish scope; high-impact actions must be granted explicitly.
  const approved_actions = clampActions(body.approved_actions?.length ? body.approved_actions : ["progress_report", "public_http_fetch", "browser_snapshot"]);
  const approved_hosts = (Array.isArray(body.approved_hosts) ? body.approved_hosts : []).map((h) => String(h || "").trim().toLowerCase()).filter(Boolean).slice(0, 10);
  const record = {
    id,
    owner_sid: session.sid,
    owner_email: session.email || "",
    title: String(body.title || "Live agent session").slice(0, 120),
    status: "open",
    approved_actions,
    approved_hosts,
    created_at: now,
    updated_at: now,
  };
  await kv.put(liveSessionKey(id), JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 7 });
  const idx = (await kv.get(userSessionsKey(session.sid), "json")) || [];
  idx.unshift({ id, title: record.title, created_at: now });
  await kv.put(userSessionsKey(session.sid), JSON.stringify(idx.slice(0, 30)), { expirationTtl: 60 * 60 * 24 * 30 });

  // Join tokens for the worker + reviewer AIs (owner hands these to the agents).
  const worker_token = await signSessionToken({ session_id: id, role: "agent", label: String(body.worker_label || "worker"), approved_actions }, env);
  const reviewer_token = await signSessionToken({ session_id: id, role: "reviewer", label: String(body.reviewer_label || "reviewer"), approved_actions: ["progress_report"] }, env);

  return jc({
    status: "created",
    session: record,
    join: {
      worker_token,                 // hand to the worker agent (e.g. GPT on the client machine)
      reviewer_token,               // hand to the reviewer brain (e.g. Claude)
      message_endpoint: new URL(`/api/agent/session/${id}/message`, request.url).toString(),
      usage: "Authorization: Bearer <token>; POST to send a typed message, GET ?since=<seq> to read.",
    },
  });
}

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const idx = (await kv.get(userSessionsKey(session.sid), "json")) || [];
  return jc({ status: "ok", sessions: idx });
}
