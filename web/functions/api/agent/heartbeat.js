import { json } from "../_auth.js";
import { agentKey, agentKv, agentUserKey, publicAgent, requireAgent } from "../_agent.js";

export async function onRequestPost({ request, env }) {
  const { response, agent: tokenAgent } = await requireAgent(request, env);
  if (response) return response;
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);
  const stored = (await kv.get(agentKey(tokenAgent.agent_id), "json")) || tokenAgent;
  const updated = { ...stored, last_seen: new Date().toISOString() };
  await kv.put(agentKey(tokenAgent.agent_id), JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });
  await kv.put(agentUserKey(tokenAgent.sid), JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });
  return json({ status: "ok", agent: publicAgent(updated) });
}
