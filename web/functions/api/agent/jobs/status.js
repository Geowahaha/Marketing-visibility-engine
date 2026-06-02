import { json, requireSession } from "../../_auth.js";
import { agentKv } from "../../_agent.js";

function secondsSince(value) {
  const t = Date.parse(value || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function timelineItem(label, at, status) {
  return { label, at: at || "", status };
}

export function jobProgress(job = {}, jobId = "") {
  const status = String(job.status || "unknown");
  const created = job.created_at || job.job?.created_at || "";
  const updated = job.updated_at || created || "";
  const delivered = job.delivered_at || "";
  const running = job.running_at || "";
  const completed = job.completed_at || "";
  const failed = status === "failed" || status === "error";
  const done = status === "completed" || status === "done";
  const queued = status === "queued" || status === "queued_for_agent";
  const deliveredState = status === "delivered_to_bridge";
  const runningState = status === "running";
  const timeline = [
    timelineItem("queued", created, created ? "done" : "pending"),
    timelineItem("delivered_to_bridge", delivered, delivered ? "done" : (queued ? "pending" : "active")),
    timelineItem("local_runner_running", running, running ? (runningState ? "active" : "done") : (deliveredState ? "pending" : "pending")),
    timelineItem("agent_result", completed, done ? "done" : failed ? "failed" : "pending"),
  ];
  let nextAction = "poll_again";
  let ownerMessage = "Job status is unknown. Check the bridge pairing or queue again.";
  if (queued) {
    nextAction = "wait_for_bridge_poll";
    ownerMessage = "Queued. Waiting for the paired bridge to poll and claim this job.";
  } else if (deliveredState) {
    nextAction = "wait_for_local_runner_result";
    ownerMessage = "Delivered to the local bridge. Waiting for the selected local AI runner to post a result.";
  } else if (runningState) {
    nextAction = "wait_for_agent_work";
    ownerMessage = job.progress_message || "The local AI runner is working. AI Mark will show the result as soon as the bridge posts it back.";
  } else if (done) {
    nextAction = "read_result";
    ownerMessage = "Agent result is ready.";
  } else if (failed) {
    nextAction = "inspect_failure";
    ownerMessage = "Agent returned a failure. Read the summary and fix the blocker before retrying.";
  } else if (status === "not_found" || !job) {
    nextAction = "start_new_job";
    ownerMessage = "No matching job was found for this account.";
  }
  const activeSeconds = secondsSince(updated || created);
  const isStale = !done && !failed && activeSeconds != null && activeSeconds > 10 * 60;
  if (isStale) {
    if (queued) {
      nextAction = "check_bridge_runner";
      ownerMessage = "No bridge has claimed this job for over 10 minutes. Start or restart the AI Mark bridge, then run the bridge self-test.";
    } else if (deliveredState || runningState) {
      nextAction = "check_local_runner";
      ownerMessage = "The job has not posted an update for over 10 minutes. Check the local runner window, restart the bridge if needed, then retry or resume the job.";
    }
  }
  return {
    job_id: jobId || job.job_id || job.id || "",
    status,
    status_label: status.replace(/_/g, " "),
    created_at: created,
    updated_at: updated,
    age_seconds: secondsSince(created),
    seconds_since_update: activeSeconds,
    stale: isStale,
    stage: job.stage || "",
    progress_message: job.progress_message || "",
    progress_events: Array.isArray(job.progress_events) ? job.progress_events.slice(-10) : [],
    next_action: nextAction,
    owner_message: ownerMessage,
    timeline,
    can_retry: failed || status === "not_found",
    poll_interval_seconds: done || failed ? 0 : 5,
  };
}

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return json({ error: "agent_kv_not_configured" }, 500);

  const url = new URL(request.url);
  let jobId = String(url.searchParams.get("job_id") || "").trim();
  if (!jobId) jobId = (await kv.get(`agent_latest_job:${session.sid}`)) || "";
  if (!jobId) return json({ status: "no_job", job: null, progress: jobProgress({ status: "not_found" }, "") });

  const job = await kv.get(`agent_job_user:${session.sid}:${jobId}`, "json");
  if (!job) return json({ status: "not_found", job_id: jobId, job: null, progress: jobProgress({ status: "not_found" }, jobId) }, 404);

  return json({
    status: job.status || "unknown",
    job_id: jobId,
    job,
    progress: jobProgress(job, jobId),
  });
}

export const onRequestPost = onRequestGet;
