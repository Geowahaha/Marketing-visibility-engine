import { json, publicUser, requireSession } from "../../_auth.js";
import {
  agentKv,
  pairCodeKey,
  pairDeviceKey,
  pairTtl,
  sessionAgentRecord,
  normalizeUserCode,
} from "../../_agent.js";

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);

  let body = {};
  try { body = await request.json(); } catch {}
  const rawCode = normalizeUserCode(body.user_code || body.code || "");
  if (rawCode.length < 8) return json({ error: "invalid_pair_code" }, 400);

  const deviceCode = await kv.get(pairCodeKey(rawCode));
  if (!deviceCode) return json({ error: "pair_code_not_found_or_expired" }, 404);

  const record = await kv.get(pairDeviceKey(deviceCode), "json");
  if (!record) return json({ error: "pair_code_not_found_or_expired" }, 404);
  if (new Date(record.expires_at).getTime() < Date.now()) return json({ error: "pair_code_expired" }, 410);
  if (record.status === "claimed") return json({ error: "pair_code_already_used" }, 409);

  const agentId = record.agent_id || crypto.randomUUID();
  const agent = sessionAgentRecord(session, agentId, record.device_name, { paired_at: new Date().toISOString() });
  const updated = {
    ...record,
    status: "approved",
    approved_at: new Date().toISOString(),
    sid: session.sid,
    user: publicUser(session),
    agent_id: agentId,
    agent,
  };
  await kv.put(pairDeviceKey(deviceCode), JSON.stringify(updated), { expirationTtl: pairTtl(updated) });
  await kv.put(pairCodeKey(rawCode), deviceCode, { expirationTtl: pairTtl(updated) });
  return json({
    status: "approved",
    user_code: updated.user_code,
    device_code: updated.device_code,
    agent: {
      agent_id: agent.agent_id,
      device_name: agent.device_name,
      mode: "cloud",
    },
    message: {
      th: "อนุมัติแล้ว กลับไปที่ bridge ได้เลย ระบบจะเชื่อมต่ออัตโนมัติ",
      en: "Approved. The bridge will connect automatically.",
    },
  });
}
