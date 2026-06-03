/**
 * Cloudflare Pages Function — /api/agent/session/:id/message
 * ------------------------------------------------------------------
 * The live message bus for one agent session (near-real-time via fast cursor
 * polling — robust on Pages, functionally live for AI-to-AI).
 *
 * POST  body { type, text?, tool?, arguments?, data? }  → append a typed message
 * GET   ?since=<seq>                                     → messages after cursor + state
 *
 * Auth: the session owner (cookie) OR a session-scoped bearer token
 * (signSessionToken). Participants can only act in THEIR session. The relay only
 * carries messages — executing a tool_request still goes through gated tools.
 */
import { requireSession } from "../../../_auth.js";
import { agentKv, liveSessionKey, liveSessionMsgsKey, verifySessionToken, bearer } from "../../../_agent.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

const TYPES = new Set(["observation", "plan", "tool_request", "tool_result", "progress", "approval_request", "approval", "handoff", "final_report", "chat"]);
const MAX_MSGS = 200;

// Resolve who is acting: session owner (cookie) or a session-token participant.
async function authParticipant(request, env, sessionId, record) {
  const session = await requireSession(request, env);
  if (session && record && session.sid === record.owner_sid) {
    return { role: "owner", label: session.email || "owner" };
  }
  const tok = await verifySessionToken(bearer(request), env);
  if (tok && tok.session_id === sessionId) {
    return { role: tok.role || "agent", label: tok.label || tok.role || "agent" };
  }
  return null;
}

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const record = await kv.get(liveSessionKey(id), "json");
  if (!record) return jc({ error: "session_not_found" }, 404);
  const who = await authParticipant(request, env, id, record);
  if (!who) return jc({ error: "session_auth_required" }, 401);

  const since = Math.max(0, parseInt(new URL(request.url).searchParams.get("since") || "0", 10) || 0);
  const all = (await kv.get(liveSessionMsgsKey(id), "json")) || [];
  const messages = all.filter((m) => Number(m.seq) > since);
  const cursor = all.length ? Number(all[all.length - 1].seq) : 0;
  return jc({ status: "ok", session: { id, status: record.status, title: record.title, approved_actions: record.approved_actions }, you: who, messages, cursor });
}

export async function onRequestPost({ request, env, params }) {
  const id = String(params.id || "");
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  const record = await kv.get(liveSessionKey(id), "json");
  if (!record) return jc({ error: "session_not_found" }, 404);
  const who = await authParticipant(request, env, id, record);
  if (!who) return jc({ error: "session_auth_required" }, 401);
  if (record.status !== "open") return jc({ error: "session_closed" }, 409);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const type = String(body.type || "chat").toLowerCase();
  if (!TYPES.has(type)) return jc({ error: "invalid_type", allowed: [...TYPES] }, 400);

  const all = (await kv.get(liveSessionMsgsKey(id), "json")) || [];
  const seq = (all.length ? Number(all[all.length - 1].seq) : 0) + 1;
  const msg = {
    seq,
    id: `m_${seq}_${crypto.randomUUID().slice(0, 6)}`,
    ts: new Date().toISOString(),
    sender: who,
    type,
    text: typeof body.text === "string" ? body.text.slice(0, 8000) : undefined,
    tool: typeof body.tool === "string" ? body.tool.slice(0, 80) : undefined,
    arguments: body.arguments && typeof body.arguments === "object" ? body.arguments : undefined,
    data: body.data && typeof body.data === "object" ? body.data : undefined,
  };
  all.push(msg);
  await kv.put(liveSessionMsgsKey(id), JSON.stringify(all.slice(-MAX_MSGS)), { expirationTtl: 60 * 60 * 24 * 7 });
  // Optional: an owner "approval"/"final_report" can close the session.
  if (who.role === "owner" && (body.close === true)) {
    record.status = "closed"; record.updated_at = new Date().toISOString();
    await kv.put(liveSessionKey(id), JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 7 });
  }
  return jc({ status: "sent", seq, message: msg });
}
