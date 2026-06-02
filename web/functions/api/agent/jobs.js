import { json, requireSession } from "../_auth.js";
import { agentKv, agentUserKey, publicAgent, readQueue, writeQueue } from "../_agent.js";
import { jobProgress } from "./jobs/status.js";

function jobId() {
  return `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function compactText(value, limit = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function jobDedupeKey(payload = {}) {
  const scanUrl = payload.scan?.url || "";
  const leadUrl = payload.lead?.url || payload.leads?.[0]?.url || "";
  const parts = [
    payload.kind || payload.type || "agent_job",
    payload.client_url || scanUrl || leadUrl || "",
    payload.target_repo || "",
    payload.hermes_task?.goal || payload.notes || "",
  ].map((x) => compactText(x).toLowerCase());
  return parts.join("|").replace(/[^a-z0-9ก-๙._:/| -]+/gi, "").slice(0, 360);
}

function activeStatus(value) {
  return ["queued", "queued_for_agent", "delivered_to_bridge", "running"].includes(String(value || "").toLowerCase());
}

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);

  const agent = await kv.get(agentUserKey(session.sid), "json");
  if (!agent?.agent_id) {
    return json({
      error: "agent_not_paired",
      connected: false,
      message: {
        th: "ยังไม่ได้ pair Agent Bridge กับบัญชีนี้",
        en: "No Agent Bridge is paired with this account.",
      },
    }, 409);
  }

  let payload = {};
  try { payload = await request.json(); } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const dedupeKey = jobDedupeKey(payload);
  const dedupeStoreKey = `agent_active_job:${session.sid}:${agent.agent_id}:${dedupeKey}`;
  const existingJobId = dedupeKey ? await kv.get(dedupeStoreKey) : "";
  if (existingJobId) {
    const existing = await kv.get(`agent_job_user:${session.sid}:${existingJobId}`, "json");
    if (existing && activeStatus(existing.status)) {
      return json({
        status: existing.status || "queued",
        connected: true,
        job_id: existingJobId,
        deduped: true,
        progress: jobProgress(existing, existingJobId),
        message: {
          th: "งานเดียวกันยังรันอยู่ จึงไม่สร้าง job ซ้ำ",
          en: "The same task is still active, so AI Mark did not create a duplicate job.",
        },
        agent: publicAgent(agent),
      });
    }
  }

  const queue = await readQueue(kv, agent.agent_id);
  const job = {
    id: jobId(),
    status: "queued",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dedupe_key: dedupeKey,
    payload,
  };
  queue.push(job);
  await writeQueue(kv, agent.agent_id, queue);
  await kv.put(`agent_job_user:${session.sid}:${job.id}`, JSON.stringify({
    job_id: job.id,
    status: "queued",
    created_at: job.created_at,
    updated_at: job.updated_at,
    dedupe_key: dedupeKey,
    payload,
    agent: publicAgent(agent),
  }), { expirationTtl: 60 * 60 * 24 * 14 });
  if (dedupeKey) {
    await kv.put(dedupeStoreKey, job.id, { expirationTtl: 60 * 60 * 24 * 14 });
  }
  await kv.put(`agent_latest_job:${session.sid}`, job.id, { expirationTtl: 60 * 60 * 24 * 14 });

  return json({
    status: "queued_for_agent",
    connected: true,
    job_id: job.id,
    queue_depth: queue.length,
    agent: publicAgent(agent),
    progress: jobProgress({
      job_id: job.id,
      status: "queued",
      created_at: job.created_at,
      updated_at: job.updated_at,
    }, job.id),
  });
}
