/**
 * AI Mark — Relational domain layer (Platform Phase 1).
 * ------------------------------------------------------------------
 * Turns the scanner into a PLATFORM by using the already-bound D1 database
 * (binding AGENT_DB, db "aimark-agent") RELATIONALLY instead of as a key/value
 * shim. This is the system-of-record for the multi-tenant data model:
 * organizations → users → projects → sites → audits (the Visibility Score
 * time-series) + findings/recommendations/competitors/citations/agent_runs.
 *
 * Design:
 *   - Tenant-scoped by org_id on every row/query (no cross-tenant leakage).
 *   - Self-healing schema: ensureSchema() runs idempotent CREATE TABLE IF NOT
 *     EXISTS once per isolate (same pattern as _agent.js d1Kv) so deploys need
 *     no manual migration step. The canonical reviewable copy lives in
 *     web/migrations/0001_platform_core.sql (kept in sync; api-smoke guards drift).
 *   - Every function is best-effort safe: if AGENT_DB is unbound it returns
 *     null/empty rather than throwing, so dual-writing from /api/scan can never
 *     break the scan response.
 */

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export function db(env) { return (env && env.AGENT_DB) || null; }
export function dbReady(env) { return !!(env && env.AGENT_DB); }

export function hostOf(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.host.replace(/^www\./i, "").toLowerCase();
  } catch { return String(url || "").trim().toLowerCase(); }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/** The runtime schema (CREATE ... IF NOT EXISTS — idempotent). Must mirror
 *  web/migrations/0001_platform_core.sql (drift-guarded in api-smoke). */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`,
  `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT, key_hash TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT 'read', created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id)`,
  `CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, industry TEXT, country TEXT, monitoring_enabled INTEGER NOT NULL DEFAULT 0, monitor_frequency TEXT NOT NULL DEFAULT 'weekly', latest_score INTEGER, created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(org_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sites_project ON sites(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sites_monitor ON sites(monitoring_enabled, monitor_frequency)`,
  `CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'visibility', status TEXT NOT NULL DEFAULT 'complete', overall_score INTEGER, scores_json TEXT, facts_json TEXT, engine_version TEXT, trigger TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_audits_site_time ON audits(site_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audits_org ON audits(org_id)`,
  `CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, audit_id TEXT NOT NULL, site_id TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, code TEXT, title TEXT NOT NULL, detail TEXT, fix_summary TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_audit ON findings(audit_id)`,
  `CREATE INDEX IF NOT EXISTS idx_findings_site_status ON findings(site_id, status)`,
  `CREATE TABLE IF NOT EXISTS recommendations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, audit_id TEXT, priority INTEGER NOT NULL DEFAULT 3, title TEXT NOT NULL, action TEXT, impact TEXT, effort TEXT, status TEXT NOT NULL DEFAULT 'suggested', applied_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_recos_site_status ON recommendations(site_id, status, priority)`,
  `CREATE TABLE IF NOT EXISTS competitors (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, competitor_url TEXT NOT NULL, competitor_host TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_competitors_site ON competitors(site_id)`,
  `CREATE TABLE IF NOT EXISTS citation_snapshots (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, engine TEXT NOT NULL, query TEXT NOT NULL, brand_cited INTEGER NOT NULL DEFAULT 0, domain_cited INTEGER NOT NULL DEFAULT 0, position INTEGER, competitors_named_json TEXT, observed_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_citations_site_time ON citation_snapshots(site_id, observed_at)`,
  `CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT, agent TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', input_json TEXT, output_json TEXT, cost_credits INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_site ON agent_runs(site_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_org ON agent_runs(org_id)`,
  `CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT, type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, delivered_channels TEXT, created_at TEXT NOT NULL, read_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_org_unread ON alerts(org_id, read_at)`,
  `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, org_id TEXT, actor TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, meta_json TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_events_org_time ON events(org_id, created_at)`,
];

const _ensured = new WeakSet();
export async function ensureSchema(env) {
  const d = db(env);
  if (!d) return false;
  if (_ensured.has(d)) return true;
  for (const stmt of SCHEMA_STATEMENTS) {
    await d.prepare(stmt).run();
  }
  _ensured.add(d);
  return true;
}

/** Lazily ensure an org + user + membership for a signed-in session.
 *  Returns { org_id, user_id } or null. */
export async function ensureOrgForSession(env, session) {
  if (!dbReady(env) || !session || !session.email) return null;
  await ensureSchema(env);
  const d = db(env);
  const email = String(session.email).toLowerCase();
  let user = await d.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  let userId = user && user.id;
  if (!userId) {
    userId = uid();
    await d.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(userId, email, String(session.name || ""), now()).run();
  }
  let mem = await d.prepare("SELECT org_id FROM memberships WHERE user_id = ? LIMIT 1").bind(userId).first();
  let orgId = mem && mem.org_id;
  if (!orgId) {
    orgId = uid();
    await d.prepare("INSERT INTO organizations (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(orgId, `${session.name || email}'s workspace`, orgId.slice(0, 8), "free", now()).run();
    await d.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(orgId, userId, "owner", now()).run();
  }
  return { org_id: orgId, user_id: userId };
}

/** The owner email of an org (so the monitoring run can act under their identity). */
export async function getOrgOwnerEmail(env, orgId) {
  if (!dbReady(env) || !orgId) return null;
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT u.email AS email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner' ORDER BY m.created_at LIMIT 1").bind(orgId).first();
  return (r && r.email) || null;
}

export async function ensureDefaultProject(env, orgId) {
  await ensureSchema(env);
  const d = db(env);
  const p = await d.prepare("SELECT id FROM projects WHERE org_id = ? ORDER BY created_at LIMIT 1").bind(orgId).first();
  if (p && p.id) return p.id;
  const id = uid();
  await d.prepare("INSERT INTO projects (id, org_id, name, created_at) VALUES (?, ?, ?, ?)").bind(id, orgId, "Default", now()).run();
  return id;
}

export async function listProjects(env, orgId) {
  if (!dbReady(env)) return [];
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT id, name, created_at FROM projects WHERE org_id = ? ORDER BY created_at").bind(orgId).all();
  return (r && r.results) || [];
}

/** Find-or-create a site for an org (dedup by host). Returns the site id. */
export async function ensureSite(env, orgId, url, meta = {}) {
  await ensureSchema(env);
  const d = db(env);
  const host = hostOf(url);
  if (!host) return null;
  const existing = await d.prepare("SELECT id FROM sites WHERE org_id = ? AND host = ? LIMIT 1").bind(orgId, host).first();
  if (existing && existing.id) return existing.id;
  const projectId = meta.project_id || await ensureDefaultProject(env, orgId);
  const id = uid();
  const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${host}`;
  await d.prepare("INSERT INTO sites (id, org_id, project_id, url, host, industry, country, monitoring_enabled, monitor_frequency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'weekly', ?)")
    .bind(id, orgId, projectId, fullUrl, host, meta.industry || null, meta.country || null, now()).run();
  return id;
}

export async function getSite(env, orgId, siteId) {
  if (!dbReady(env)) return null;
  await ensureSchema(env);
  return await db(env).prepare("SELECT id, org_id, project_id, host, url, latest_score, monitoring_enabled, monitor_frequency, industry, country, created_at, updated_at FROM sites WHERE id = ? AND org_id = ?").bind(siteId, orgId).first();
}

export async function listSites(env, orgId) {
  if (!dbReady(env)) return [];
  await ensureSchema(env);
  const r = await db(env).prepare(
    "SELECT s.id, s.host, s.url, s.latest_score, s.monitoring_enabled, s.created_at, " +
    "(SELECT COUNT(*) FROM audits a WHERE a.site_id = s.id) AS audits_count, " +
    "(SELECT MAX(created_at) FROM audits a WHERE a.site_id = s.id) AS last_audit_at " +
    "FROM sites s WHERE s.org_id = ? ORDER BY s.created_at DESC LIMIT 200"
  ).bind(orgId).all();
  return (r && r.results) || [];
}

/** Record one audit (the Visibility Score time-series row) + denormalize latest_score. */
export async function recordAudit(env, { orgId, siteId, kind = "visibility", overall, scores, facts, engineVersion, trigger = "manual" }) {
  await ensureSchema(env);
  const d = db(env);
  const id = uid();
  const score = (overall == null || Number.isNaN(Number(overall))) ? null : Math.round(Number(overall));
  await d.prepare("INSERT INTO audits (id, org_id, site_id, kind, status, overall_score, scores_json, facts_json, engine_version, trigger, created_at) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?, ?)")
    .bind(id, orgId, siteId, kind, score, scores ? JSON.stringify(scores) : null, facts ? JSON.stringify(facts) : null, engineVersion || null, trigger, now()).run();
  await d.prepare("UPDATE sites SET latest_score = ?, updated_at = ? WHERE id = ?").bind(score, now(), siteId).run();
  return id;
}

export async function recordFindings(env, { orgId, siteId, auditId, findings = [] }) {
  if (!Array.isArray(findings) || !findings.length) return 0;
  await ensureSchema(env);
  const d = db(env);
  let n = 0;
  for (const f of findings.slice(0, 50)) {
    await d.prepare("INSERT INTO findings (id, org_id, audit_id, site_id, category, severity, code, title, detail, fix_summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
      .bind(uid(), orgId, auditId, siteId, String(f.category || "general").slice(0, 40), String(f.severity || "info").slice(0, 20), f.code ? String(f.code).slice(0, 80) : null, String(f.title || f.check || "issue").slice(0, 200), String(f.detail || "").slice(0, 1000), String(f.fix || f.fix_summary || "").slice(0, 1000), now()).run();
    n += 1;
  }
  return n;
}

export async function listAudits(env, orgId, siteId, limit = 60) {
  if (!dbReady(env)) return [];
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT id, kind, overall_score, scores_json, trigger, created_at FROM audits WHERE site_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT ?").bind(siteId, orgId, limit).all();
  return ((r && r.results) || []).map((a) => ({ id: a.id, kind: a.kind, overall_score: a.overall_score, scores: a.scores_json ? safeParse(a.scores_json) : null, trigger: a.trigger, created_at: a.created_at }));
}

/** Persist prioritized recommendations (Actionable Intelligence) for one audit. */
export async function recordRecommendations(env, { orgId, siteId, auditId, recs = [] }) {
  if (!Array.isArray(recs) || !recs.length) return 0;
  await ensureSchema(env);
  const d = db(env);
  let n = 0;
  for (const r of recs.slice(0, 30)) {
    await d.prepare("INSERT INTO recommendations (id, org_id, site_id, audit_id, priority, title, action, impact, effort, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?)")
      .bind(uid(), orgId, siteId, auditId || null, Math.max(1, Math.min(5, Number(r.priority) || 3)), String(r.title || "improve").slice(0, 200), String(r.action || "").slice(0, 300), String(r.impact || "").slice(0, 300), String(r.effort || "medium").slice(0, 20), now()).run();
    n += 1;
  }
  return n;
}

/** The current action list = the most recent audit's recommendations, priority-first. */
export async function listRecommendationsForAudit(env, orgId, auditId) {
  if (!dbReady(env) || !auditId) return [];
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT id, priority, title, action, impact, effort, status, created_at FROM recommendations WHERE org_id = ? AND audit_id = ? ORDER BY priority, created_at").bind(orgId, auditId).all();
  return (r && r.results) || [];
}

/** Toggle continuous monitoring for a site (the recurring-revenue switch). */
export async function setMonitoring(env, orgId, siteId, enabled, frequency) {
  await ensureSchema(env);
  const d = db(env);
  const site = await d.prepare("SELECT id FROM sites WHERE id = ? AND org_id = ?").bind(siteId, orgId).first();
  if (!site) return null;
  await d.prepare("UPDATE sites SET monitoring_enabled = ?, monitor_frequency = ?, updated_at = ? WHERE id = ? AND org_id = ?")
    .bind(enabled ? 1 : 0, String(frequency || "weekly").slice(0, 16), now(), siteId, orgId).run();
  return await getSite(env, orgId, siteId);
}

/** Sites due for a scheduled re-audit (drives the monitoring Worker/cron). */
export async function listMonitoredSites(env) {
  if (!dbReady(env)) return [];
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT id, org_id, host, url, latest_score, monitor_frequency FROM sites WHERE monitoring_enabled = 1 ORDER BY updated_at LIMIT 500").all();
  return (r && r.results) || [];
}

/** Record an alert (the reason customers come back = the recurring-revenue heartbeat). */
export async function recordAlert(env, { orgId, siteId, type, severity = "info", message }) {
  await ensureSchema(env);
  const id = uid();
  await db(env).prepare("INSERT INTO alerts (id, org_id, site_id, type, severity, message, delivered_channels, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, orgId, siteId || null, String(type || "info").slice(0, 40), String(severity).slice(0, 20), String(message || "").slice(0, 300), "", now()).run();
  return id;
}

export async function listAlerts(env, orgId, limit = 50) {
  if (!dbReady(env)) return [];
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT id, site_id, type, severity, message, created_at, read_at FROM alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT ?").bind(orgId, limit).all();
  return (r && r.results) || [];
}

/** Capture one AI-citation observation = the Visibility Intelligence time-series.
 *  Can't be backfilled — every probe persisted now is permanent dataset value. */
export async function recordCitationSnapshot(env, { orgId, siteId, engine, query, brandCited, domainCited, position = null, competitorsNamed = [] }) {
  await ensureSchema(env);
  const id = uid();
  await db(env).prepare("INSERT INTO citation_snapshots (id, org_id, site_id, engine, query, brand_cited, domain_cited, position, competitors_named_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, orgId, siteId, String(engine || "").slice(0, 40), String(query || "").slice(0, 300), brandCited ? 1 : 0, domainCited ? 1 : 0, position == null ? null : Number(position), (competitorsNamed && competitorsNamed.length) ? JSON.stringify(competitorsNamed.slice(0, 10)) : null, now()).run();
  return id;
}

export async function listCitationSnapshots(env, orgId, siteId, limit = 200) {
  if (!dbReady(env)) return [];
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT engine, query, brand_cited, domain_cited, competitors_named_json, observed_at FROM citation_snapshots WHERE site_id = ? AND org_id = ? ORDER BY observed_at DESC LIMIT ?").bind(siteId, orgId, limit).all();
  return ((r && r.results) || []).map((x) => ({ engine: x.engine, query: x.query, brand_cited: !!x.brand_cited, domain_cited: !!x.domain_cited, competitors_named: x.competitors_named_json ? (safeParse(x.competitors_named_json) || []) : [], observed_at: x.observed_at }));
}

/** Audit-trail / behavioral event (also the substrate for outcome correlation). */
export async function recordEvent(env, { orgId = null, actor = null, action, targetType = null, targetId = null, meta = null }) {
  if (!dbReady(env) || !action) return null;
  await ensureSchema(env);
  const id = uid();
  await db(env).prepare("INSERT INTO events (id, org_id, actor, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, orgId, actor ? String(actor).slice(0, 120) : null, String(action).slice(0, 60), targetType, targetId, meta ? JSON.stringify(meta) : null, now()).run();
  return id;
}

/** Mark a recommendation APPLIED = the adoption signal, and snapshot the site's
 *  score at that moment (an event) so the OUTCOME (next audit's delta) is
 *  measurable later. Returns null if the rec isn't owned by the org. This is the
 *  can't-backfill "did the customer act?" capture. */
export async function markRecommendationApplied(env, orgId, recId, actor = "owner") {
  if (!dbReady(env)) return null;
  await ensureSchema(env);
  const d = db(env);
  const rec = await d.prepare("SELECT id, site_id, title, priority FROM recommendations WHERE id = ? AND org_id = ? LIMIT 1").bind(recId, orgId).first();
  if (!rec) return null;
  const site = await d.prepare("SELECT latest_score FROM sites WHERE id = ? AND org_id = ? LIMIT 1").bind(rec.site_id, orgId).first();
  const scoreAtApply = (site && site.latest_score != null) ? Number(site.latest_score) : null;
  const at = now();
  await d.prepare("UPDATE recommendations SET status = 'applied', applied_at = ? WHERE id = ? AND org_id = ?").bind(at, recId, orgId).run();
  await recordEvent(env, { orgId, actor, action: "recommendation_applied", targetType: "recommendation", targetId: recId, meta: { site_id: rec.site_id, score_at_apply: scoreAtApply, title: rec.title, priority: rec.priority } });
  return { rec_id: recId, site_id: rec.site_id, status: "applied", applied_at: at, score_at_apply: scoreAtApply };
}

/** Correlate adoption -> outcome: for each applied recommendation on a site, the
 *  score delta from when it was applied to the next audit. The "did the fix work?"
 *  training data — aggregated across customers this becomes the revenue/success-
 *  correlation moat ("applying FAQ schema correlates with +X AI visibility"). */
export async function recommendationImpact(env, orgId, siteId) {
  const empty = { applied: 0, measured: 0, avg_delta: null, items: [] };
  if (!dbReady(env)) return empty;
  await ensureSchema(env);
  const d = db(env);
  const applied = await d.prepare("SELECT id, title, applied_at FROM recommendations WHERE org_id = ? AND site_id = ? AND status = 'applied' AND applied_at IS NOT NULL ORDER BY applied_at DESC LIMIT 100").bind(orgId, siteId).all();
  const rows = (applied && applied.results) || [];
  const items = [];
  let sum = 0, measured = 0;
  for (const r of rows) {
    const ev = await d.prepare("SELECT meta_json FROM events WHERE target_id = ? AND action = 'recommendation_applied' ORDER BY created_at DESC LIMIT 1").bind(r.id).first();
    const meta = (ev && ev.meta_json) ? (safeParse(ev.meta_json) || {}) : {};
    const scoreAtApply = meta.score_at_apply == null ? null : Number(meta.score_at_apply);
    const next = await d.prepare("SELECT overall_score FROM audits WHERE site_id = ? AND org_id = ? AND created_at > ? AND overall_score IS NOT NULL ORDER BY created_at ASC LIMIT 1").bind(siteId, orgId, r.applied_at).first();
    const outcome = (next && next.overall_score != null) ? Number(next.overall_score) : null;
    const delta = (scoreAtApply != null && outcome != null) ? (outcome - scoreAtApply) : null;
    if (delta != null) { sum += delta; measured += 1; }
    items.push({ rec_id: r.id, title: r.title, applied_at: r.applied_at, score_at_apply: scoreAtApply, outcome_score: outcome, delta });
  }
  return { applied: rows.length, measured, avg_delta: measured ? +(sum / measured).toFixed(1) : null, items };
}

/** Register a tracked competitor for a site (dedup by host). */
export async function recordCompetitor(env, { orgId, siteId, competitorUrl }) {
  if (!dbReady(env)) return null;
  await ensureSchema(env);
  const d = db(env);
  const host = hostOf(competitorUrl);
  if (!host) return null;
  const existing = await d.prepare("SELECT id FROM competitors WHERE org_id = ? AND site_id = ? AND competitor_host = ? LIMIT 1").bind(orgId, siteId, host).first();
  if (existing && existing.id) return existing.id;
  const id = uid();
  await d.prepare("INSERT INTO competitors (id, org_id, site_id, competitor_url, competitor_host, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, orgId, siteId, String(competitorUrl).slice(0, 400), host, now()).run();
  return id;
}

/** Capture one competitor-position observation = the competitor time-series.
 *  Stored as an event keyed by site (target_id) so a single read reconstructs each
 *  competitor's trend vs the customer. Can't-backfill: who's beating you, over time. */
export async function recordCompetitorSnapshot(env, { orgId, siteId, competitorHost, competitorScore, targetScore }) {
  const cs = competitorScore == null ? null : Number(competitorScore);
  const ts = targetScore == null ? null : Number(targetScore);
  return recordEvent(env, {
    orgId, actor: "system", action: "competitor_snapshot", targetType: "competitor", targetId: siteId,
    meta: { site_id: siteId, competitor_host: String(competitorHost || "").slice(0, 120), competitor_score: cs, target_score: ts, gap: (cs != null && ts != null) ? (cs - ts) : null },
  });
}

/** Reconstruct each competitor's score trend vs the customer's, newest first. */
export async function competitorTrend(env, orgId, siteId, limit = 300) {
  if (!dbReady(env)) return { competitors: [] };
  await ensureSchema(env);
  const r = await db(env).prepare("SELECT meta_json, created_at FROM events WHERE org_id = ? AND action = 'competitor_snapshot' AND target_id = ? ORDER BY created_at DESC LIMIT ?").bind(orgId, siteId, limit).all();
  const byHost = new Map();
  for (const row of (r && r.results) || []) {
    const m = row.meta_json ? (safeParse(row.meta_json) || {}) : {};
    const host = m.competitor_host;
    if (!host) continue;
    const obs = { competitor_score: m.competitor_score, target_score: m.target_score, gap: m.gap, at: row.created_at };
    if (!byHost.has(host)) byHost.set(host, { host, latest: obs, observations: [obs] });
    else byHost.get(host).observations.push(obs);
  }
  return { competitors: [...byHost.values()] };
}

export function publicSite(site) {
  if (!site) return null;
  return {
    id: site.id, host: site.host, url: site.url,
    latest_score: site.latest_score == null ? null : Number(site.latest_score),
    monitoring_enabled: !!site.monitoring_enabled,
    monitor_frequency: site.monitor_frequency || "weekly",
    industry: site.industry || null, country: site.country || null,
    audits_count: site.audits_count == null ? undefined : Number(site.audits_count),
    last_audit_at: site.last_audit_at || undefined,
    created_at: site.created_at,
  };
}
