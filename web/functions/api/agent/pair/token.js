import { json } from "../../_auth.js";
import {
  agentKey,
  agentKv,
  pairCodeKey,
  agentUserKey,
  pairDeviceKey,
  pairTtl,
  publicAgent,
  signAgentToken,
} from "../../_agent.js";

export async function onRequestPost({ request, env }) {
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);
  let body = {};
  try { body = await request.json(); } catch {}
  const deviceCode = String(body.device_code || "").trim();
  if (!deviceCode) return json({ error: "device_code_required" }, 400);

  const record = await kv.get(pairDeviceKey(deviceCode), "json");
  if (!record) return json({ error: "device_code_not_found_or_expired" }, 404);
  if (new Date(record.expires_at).getTime() < Date.now()) return json({ error: "device_code_expired" }, 410);
  if (record.status === "pending") {
    return json({
      error: "authorization_pending",
      status: "pending",
      user_code: record.user_code,
      verification_uri_complete: record.verification_uri_complete,
    }, 428);
  }
  if (record.status !== "approved" || !record.agent || !record.sid) {
    return json({ error: "device_code_not_approved" }, 409);
  }

  const now = new Date().toISOString();
  const agent = { ...record.agent, last_seen: now };
  const token = await signAgentToken(agent, env);
  await kv.put(agentKey(agent.agent_id), JSON.stringify(agent), { expirationTtl: 60 * 60 * 24 * 90 });
  await kv.put(agentUserKey(record.sid), JSON.stringify(agent), { expirationTtl: 60 * 60 * 24 * 90 });
  await kv.put(pairDeviceKey(deviceCode), JSON.stringify({ ...record, status: "claimed", claimed_at: now, agent }), { expirationTtl: pairTtl(record) });
  await kv.delete(pairCodeKey(record.raw_code || record.user_code));

  return json({
    status: "paired",
    agent_token: token,
    agent: publicAgent(agent),
    poll_url: "/api/agent/jobs/poll",
    ack_url: "/api/agent/jobs/ack",
  });
}
