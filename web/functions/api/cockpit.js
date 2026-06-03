/**
 * Cloudflare Pages Function — GET /api/cockpit
 * ------------------------------------------------------------------
 * Owner Cockpit aggregation: one authenticated read that powers the cockpit's
 * business-operating-layer panels from REAL per-account data.
 *
 *   missions   — recent agent jobs (from the per-user job index) + live status
 *   approvals  — high-impact jobs (deploy/PR/site change) to review, + failures
 *   leads      — last persisted lead-scout run for this owner
 *   inbox      — honest: not connected (no LINE/email system yet)
 *   content    — honest: not connected (no content-calendar store yet)
 *
 * Honesty guardrail: panels with no backing system report { available:false }
 * with a reason — never fabricated data.
 */

import { json, requireSession } from "./_auth.js";
import { agentKv } from "./_agent.js";

function statusBucket(status) {
  const s = String(status || "").toLowerCase();
  if (s === "completed" || s === "done") return "verified";
  if (s === "failed" || s === "error") return "failed";
  if (s === "running") return "running";
  if (s === "delivered_to_bridge") return "delivered";
  if (s === "queued" || s === "queued_for_agent") return "queued";
  return s || "unknown";
}
const ACTIVE = new Set(["queued", "queued_for_agent", "delivered_to_bridge", "running"]);

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) {
    return json({
      authenticated: false,
      message: { th: "เข้าสู่ระบบเพื่อดูภาพรวมบริษัทของคุณ", en: "Sign in to see your company overview." },
    });
  }
  const kv = agentKv(env);
  if (!kv) {
    return json({ authenticated: true, connected: false, error: "agent_kv_not_configured" }, 200);
  }

  const agent = await kv.get(`agent_user:${session.sid}`, "json");

  // Missions from the per-user job index, hydrated with live status.
  const index = (await kv.get(`agent_jobs_index:${session.sid}`, "json")) || [];
  const missions = [];
  for (const entry of index.slice(0, 12)) {
    const rec = await kv.get(`agent_job_user:${session.sid}:${entry.job_id}`, "json");
    const status = rec?.status || "queued";
    missions.push({
      job_id: entry.job_id,
      kind: entry.kind || rec?.payload?.kind || "agent_job",
      title: entry.title || rec?.payload?.client_url || rec?.payload?.scan?.url || entry.job_id,
      status,
      bucket: statusBucket(status),
      high_impact: !!entry.high_impact,
      summary: rec?.summary || rec?.progress_message || "",
      created_at: entry.created_at || rec?.created_at || "",
      updated_at: rec?.updated_at || entry.created_at || "",
    });
  }

  // Approvals: high-impact jobs (change the site) that are active or just failed —
  // the work an owner should review. This is a review surface, not a start-gate.
  const approvals = missions
    .filter((m) => (m.high_impact && ACTIVE.has(m.status)) || m.bucket === "failed")
    .map((m) => ({
      job_id: m.job_id,
      title: m.title,
      reason: m.bucket === "failed" ? "failed_needs_attention" : "high_impact_in_progress",
      status: m.status,
    }));

  // Leads: last persisted lead-scout run for this owner.
  const leadDoc = await kv.get(`cockpit_leads:${session.sid}`, "json");

  const active = missions.filter((m) => ACTIVE.has(m.status)).length;

  return json({
    authenticated: true,
    connected: !!agent?.agent_id,
    account: { email: session.email || "", device_name: agent?.device_name || "" },
    kpis: {
      missions_total: missions.length,
      missions_active: active,
      approvals: approvals.length,
      leads: leadDoc?.count || 0,
    },
    missions: { available: true, items: missions },
    approvals: { available: true, items: approvals },
    leads: leadDoc
      ? { available: true, query: leadDoc.query || "", count: leadDoc.count || 0, generated_at: leadDoc.generated_at || "", items: leadDoc.leads || [] }
      : { available: true, items: [], note: { th: "ยังไม่มี lead — รัน Find prospects ใน AI Mark", en: "No leads yet — run Find prospects in AI Mark." } },
    inbox: { available: false, reason: { th: "ยังไม่ได้เชื่อม LINE/อีเมล", en: "LINE/email inbox not connected yet." } },
    content: { available: false, reason: { th: "ยังไม่มีปฏิทินคอนเทนต์ที่บันทึกไว้", en: "No saved content calendar yet." } },
    generated_at: new Date().toISOString(),
  });
}

export const onRequestPost = onRequestGet;
