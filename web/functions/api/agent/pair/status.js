import { json, requireSession } from "../../_auth.js";
import {
  agentKv,
  agentUserKey,
  pairCodeKey,
  pairDeviceKey,
  publicAgent,
  normalizeUserCode,
} from "../../_agent.js";

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);

  const url = new URL(request.url);
  const rawCode = normalizeUserCode(url.searchParams.get("code") || "");
  let pair = null;
  if (rawCode) {
    const deviceCode = await kv.get(pairCodeKey(rawCode));
    if (deviceCode) {
      const record = await kv.get(pairDeviceKey(deviceCode), "json");
      if (record) {
        pair = {
          status: record.status,
          user_code: record.user_code,
          expires_at: record.expires_at,
          approved: record.status === "approved" || record.status === "claimed",
          claimed: record.status === "claimed",
        };
      }
    }
  }

  const agent = await kv.get(agentUserKey(session.sid), "json");
  return json({
    status: agent ? "connected" : "not_connected",
    connected: !!agent,
    agent: publicAgent(agent),
    pair,
  });
}
