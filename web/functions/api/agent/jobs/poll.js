import { json } from "../../_auth.js";
import {
  agentKey,
  agentKv,
  agentUserKey,
  publicAgent,
  readQueue,
  requireAgent,
  writeQueue,
} from "../../_agent.js";

export async function onRequestGet({ request, env }) {
  const { response, agent: tokenAgent } = await requireAgent(request, env);
  if (response) return response;
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);

  const stored = (await kv.get(agentKey(tokenAgent.agent_id), "json")) || tokenAgent;
  const now = new Date().toISOString();
  const updated = { ...stored, last_seen: now };
  await kv.put(agentKey(tokenAgent.agent_id), JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });
  await kv.put(agentUserKey(tokenAgent.sid), JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 90 });

  const queue = await readQueue(kv, tokenAgent.agent_id);
  const job = queue[0] || null;
  if (job?.id) {
    const next = queue.filter((item) => item.id !== job.id);
    const deliveredAt = new Date().toISOString();
    await writeQueue(kv, tokenAgent.agent_id, next);
    const jobKey = `agent_job_user:${tokenAgent.sid}:${job.id}`;
    const current = (await kv.get(jobKey, "json")) || { job_id: job.id, payload: job.payload || {} };
    await kv.put(jobKey, JSON.stringify({
      ...current,
      job_id: job.id,
      status: "delivered_to_bridge",
      delivered_at: current.delivered_at || deliveredAt,
      updated_at: deliveredAt,
      agent: publicAgent(updated),
    }), { expirationTtl: 60 * 60 * 24 * 14 });
    return json({
      status: "job_available",
      interval: 5,
      claimed: true,
      queue_depth: next.length,
      agent: publicAgent(updated),
      job: {
        ...job,
        status: "delivered_to_bridge",
        delivered_at: current.delivered_at || deliveredAt,
      },
    });
  }
  return json({
    status: "idle",
    interval: 5,
    queue_depth: 0,
    agent: publicAgent(updated),
    job: null,
  });
}

export const onRequestPost = onRequestGet;
