import { json } from "../../_auth.js";
import { agentKv, requireAgent } from "../../_agent.js";

const ACTIVE_STATUSES = new Set(["running", "delivered_to_bridge"]);
const FINAL_STATUSES = new Set(["failed", "error"]);

function compact(value, limit = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function compactList(value, limit = 8, itemLimit = 500) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return compact(item, itemLimit);
      if (item && typeof item === "object") {
        return {
          label: compact(item.label || item.name || item.path || item.url || "", 160),
          url: compact(item.url || item.href || "", itemLimit),
          path: compact(item.path || item.file || "", itemLimit),
          status: compact(item.status || "", 80),
        };
      }
      return "";
    })
    .filter((item) => item && (typeof item === "string" || item.label || item.url || item.path || item.status))
    .slice(0, limit);
}

function safeStatus(value) {
  const status = String(value || "running").trim().toLowerCase();
  if (ACTIVE_STATUSES.has(status) || FINAL_STATUSES.has(status)) return status;
  return "running";
}

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

  const jobKey = `agent_job_user:${agent.sid}:${jobId}`;
  const current = await kv.get(jobKey, "json");
  if (!current) return json({ error: "job_not_found", job_id: jobId }, 404);

  const now = new Date().toISOString();
  const status = safeStatus(body.status);
  const event = {
    at: now,
    status,
    stage: compact(body.stage || body.step || "", 120),
    action: compact(body.action || body.action_type || "", 120),
    target_url: compact(body.target_url || body.url || "", 500),
    message: compact(body.message || body.summary || "", 800),
    screenshot_url: compact(body.screenshot_url || body.screenshot || "", 500),
    proof_links: compactList(body.proof_links || body.links, 5, 500),
    files: compactList(body.files, 8, 500),
    runner_label: compact(body.runner_label || body.runner?.label || body.result?.runner_label || "", 160),
  };
  const events = Array.isArray(current.progress_events) ? current.progress_events.slice(-29) : [];
  events.push(event);

  const update = {
    ...current,
    status,
    stage: event.stage || current.stage || "",
    live_action: event.action || current.live_action || "",
    live_target_url: event.target_url || current.live_target_url || "",
    progress_message: event.message || current.progress_message || "",
    progress_events: events,
    updated_at: now,
    runner: body.runner || current.runner || null,
  };
  if (status === "running") update.running_at = current.running_at || now;
  if (status === "delivered_to_bridge") update.delivered_at = current.delivered_at || now;
  if (FINAL_STATUSES.has(status)) {
    update.failed_at = current.failed_at || now;
    update.completed_at = current.completed_at || now;
    update.summary = compact(body.summary || body.message || current.summary || "Local agent reported a failure.", 4000);
    update.markdown = String(body.markdown || current.markdown || "").slice(0, 20000);
  }

  await kv.put(jobKey, JSON.stringify(update), { expirationTtl: 60 * 60 * 24 * 30 });
  return json({
    status: "progress_recorded",
    job_id: jobId,
    job_status: status,
    stage: update.stage,
    action: update.live_action,
    visible_to_user: true,
  });
}
