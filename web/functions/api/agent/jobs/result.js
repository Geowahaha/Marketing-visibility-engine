import { json } from "../../_auth.js";
import { agentKv, requireAgent } from "../../_agent.js";

export async function onRequestPost({ request, env }) {
  const { response, agent } = await requireAgent(request, env);
  if (response) return response;
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);

  let body = {};
  try { body = await request.json(); } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const jobId = String(body.job_id || body.id || "").trim();
  if (!jobId) return json({ error: "job_id_required" }, 400);

  const now = new Date().toISOString();
  const jobKey = `agent_job_user:${agent.sid}:${jobId}`;
  const current = (await kv.get(jobKey, "json")) || { job_id: jobId };
  const result = {
    ...current,
    job_id: jobId,
    status: String(body.status || "completed"),
    summary: String(body.summary || "").slice(0, 4000),
    result: body.result || body.data || null,
    markdown: String(body.markdown || "").slice(0, 20000),
    files: Array.isArray(body.files) ? body.files.slice(0, 50) : [],
    proof_links: Array.isArray(body.proof_links) ? body.proof_links.slice(0, 30) : [],
    completed_at: now,
    updated_at: now,
  };
  await kv.put(jobKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 30 });
  await kv.put(`agent_latest_result:${agent.sid}`, jobId, { expirationTtl: 60 * 60 * 24 * 30 });

  return json({
    status: "result_recorded",
    job_id: jobId,
    visible_to_user: true,
  });
}
