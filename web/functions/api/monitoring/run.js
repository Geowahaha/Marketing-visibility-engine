/**
 * POST /api/monitoring/run  — Monitoring Automation (P2).
 * ------------------------------------------------------------------
 * The autonomous heartbeat that makes the Growth Monitor subscription actually
 * CONTINUOUS (otherwise customers pay for "monitoring" that only runs when they
 * scan by hand = churn). A thin external scheduler triggers this:
 *   - a Cloudflare Cron Worker (preferred), OR a GitHub Action cron, OR any
 *     uptime pinger — POST here with header `x-cron-key: <AIMARK_CRON_KEY>`.
 *
 * For each monitored site (bounded batch — cost control):
 *   1) renewal protection: if the owner's plan lapsed, PAUSE monitoring + raise a
 *      renewal_reminder alert (stop giving away the paid value; nudge the 2nd cycle).
 *      If it expires soon, raise a gentle reminder.
 *   2) due re-audit: if active plan + the last audit is older than the site's
 *      frequency, re-audit by replaying the REAL /api/scan path under the owner's
 *      identity (identical scoring + history + score-drop alert; no duplicate code).
 *
 * Gate: header x-cron-key === env.AIMARK_CRON_KEY (or AIMARK_ADMIN_KEY).
 */
import { signSession } from "../_auth.js";
import { dbReady, listMonitoredSites, listAudits, recordAlert, setMonitoring, getOrgOwnerEmail } from "../_db.js";
import { getActivePlan } from "../_entitlements.js";
import { onRequestPost as scanSite } from "../scan.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-cron-key" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

const MAX_SITES = 8;   // sites scanned per run (subrequest budget)
const MAX_AUDITS = 4;  // expensive re-audits per run (cost control)
const FREQ_MS = { daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 };
const REMINDER_WINDOW_MS = 5 * 86400000; // "expires soon" nudge window

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const cronKey = String(env.AIMARK_CRON_KEY || env.AIMARK_ADMIN_KEY || "");
  if (!cronKey) return jc({ error: "monitoring_cron_not_configured", detail: "Set AIMARK_CRON_KEY to enable scheduled monitoring." }, 501);
  if (String(request.headers.get("x-cron-key") || "") !== cronKey) return jc({ error: "forbidden" }, 403);
  if (!dbReady(env)) return jc({ error: "platform_db_not_configured" }, 501);

  const sites = await listMonitoredSites(env); // stalest first
  const summary = { monitored: sites.length, scanned: 0, due: 0, audited: 0, reminders: 0, paused_expired: 0, errors: 0 };
  const now = Date.now();

  for (const site of sites) {
    if (summary.scanned >= MAX_SITES) break;
    summary.scanned += 1;
    try {
      const owner = await getOrgOwnerEmail(env, site.org_id);
      if (!owner) continue;
      const plan = await getActivePlan(env, owner);

      // (1) Plan lapsed → pause monitoring (stop giving away paid value) + remind.
      if (!plan) {
        await recordAlert(env, { orgId: site.org_id, siteId: site.id, type: "renewal_reminder", severity: "high", message: `Monitoring paused for ${site.host} — renew Growth Monitor to resume continuous checks.` });
        await setMonitoring(env, site.org_id, site.id, false, site.monitor_frequency);
        summary.paused_expired += 1; summary.reminders += 1;
        continue;
      }
      // Expiring soon → gentle nudge (drives the second payment cycle).
      if (plan.current_period_end && (new Date(plan.current_period_end).getTime() - now) < REMINDER_WINDOW_MS) {
        await recordAlert(env, { orgId: site.org_id, siteId: site.id, type: "renewal_reminder", severity: "info", message: `Your Growth Monitor renews soon — keep monitoring ${site.host} active.` });
        summary.reminders += 1;
      }

      // (2) Due re-audit?
      if (summary.audited >= MAX_AUDITS) continue;
      const recent = await listAudits(env, site.org_id, site.id, 1);
      const lastAt = recent[0] ? new Date(recent[0].created_at).getTime() : 0;
      const windowMs = FREQ_MS[site.monitor_frequency] || FREQ_MS.weekly;
      if (now - lastAt < windowMs) continue; // not due yet
      summary.due += 1;

      if (!env.AUTH_SESSION_SECRET) continue; // can't mint an owner session to persist
      const { token } = await signSession({ sid: `system:${site.org_id}`, provider: "system", email: owner, name: "Monitor" }, env.AUTH_SESSION_SECRET);
      const res = await scanSite({
        request: new Request("https://aimark.pages.dev/api/scan", { method: "POST", headers: { "content-type": "application/json", cookie: `aimark_session=${token}` }, body: JSON.stringify({ url: site.url, deterministic_only: true }) }),
        env,
      });
      if (res && res.ok) summary.audited += 1; else summary.errors += 1;
    } catch { summary.errors += 1; }
  }

  return jc({ status: "ok", ...summary, batch: { max_sites: MAX_SITES, max_audits: MAX_AUDITS }, note: "Schedule a trigger (CF Cron Worker / GitHub Action) to POST here periodically." });
}
