import { json } from "../../_auth.js";
import { agentKv, readQueue, requireAgent, writeQueue } from "../../_agent.js";

export async function onRequestPost({ request, env }) {
  const { response, agent } = await requireAgent(request, env);
  if (response) return response;
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);
  let body = {};
  try { body = await request.json(); } catch {}
  const jobId = String(body.job_id || "").trim();
  if (!jobId) return json({ error: "job_id_required" }, 400);

  const queue = await readQueue(kv, agent.agent_id);
  const next = queue.filter((job) => job.id !== jobId);
  await writeQueue(kv, agent.agent_id, next);
  const jobKey = `agent_job_user:${agent.sid}:${jobId}`;
  const current = (await kv.get(jobKey, "json")) || { job_id: jobId };
  await kv.put(jobKey, JSON.stringify({
    ...current,
    status: "delivered_to_bridge",
    delivered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 14 });
  return json({
    status: "acknowledged",
    job_id: jobId,
    queue_depth: next.length,
  });
}
