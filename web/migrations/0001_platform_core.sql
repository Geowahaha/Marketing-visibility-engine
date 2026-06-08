-- AI Mark — Platform Core (relational system-of-record on D1/SQLite)
-- ------------------------------------------------------------------
-- This is the move that turns the scanner into a PLATFORM: D1 is already bound
-- (binding AGENT_DB, db "aimark-agent") but today it is used only as a key/value
-- shim (_agent.js d1Kv). Used RELATIONALLY it gives us history, multi-tenancy,
-- trend, and a data moat — with NO new infrastructure.
--
-- Apply:  cd web && npx wrangler d1 migrations apply aimark-agent --remote
-- Local:  npx wrangler d1 migrations apply aimark-agent --local
--
-- Conventions: ids = uuid TEXT; timestamps = ISO-8601 TEXT (lexicographically
-- sortable for time-series); *_json = TEXT holding JSON. Everything tenant-scoped
-- by org_id from day one (cheap now, agony to retrofit later).

-- ── Tenancy & identity ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free',     -- free | starter | growth | pro | enterprise
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,             -- aligns with the existing session.email
  name        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'owner',    -- owner | admin | member | viewer (RBAC)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  name         TEXT,
  key_hash     TEXT NOT NULL,                   -- store a hash, never the key
  scopes       TEXT NOT NULL DEFAULT 'read',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id);

-- ── Domain: projects → sites ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

CREATE TABLE IF NOT EXISTS sites (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id),
  project_id         TEXT NOT NULL REFERENCES projects(id),
  url                TEXT NOT NULL,
  host               TEXT NOT NULL,
  industry           TEXT,                       -- powers benchmark cohorts (the data moat)
  country            TEXT,
  monitoring_enabled INTEGER NOT NULL DEFAULT 0, -- the recurring-revenue switch
  monitor_frequency  TEXT NOT NULL DEFAULT 'weekly', -- daily | weekly | monthly
  latest_score       INTEGER,                    -- denormalized for fast dashboard lists
  created_at         TEXT NOT NULL,
  updated_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(org_id);
CREATE INDEX IF NOT EXISTS idx_sites_project ON sites(project_id);
CREATE INDEX IF NOT EXISTS idx_sites_monitor ON sites(monitoring_enabled, monitor_frequency);

-- ── Audits: the Visibility Score TIME-SERIES (the retention hook) ──────────
CREATE TABLE IF NOT EXISTS audits (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  site_id        TEXT NOT NULL REFERENCES sites(id),
  kind           TEXT NOT NULL DEFAULT 'visibility', -- visibility | tech | conversion | local_seo | social
  status         TEXT NOT NULL DEFAULT 'complete',   -- queued | running | complete | failed
  overall_score  INTEGER,
  scores_json    TEXT,                            -- {search, ai_search, technical, social, performance}
  facts_json     TEXT,                            -- deterministic check facts (the moat input)
  engine_version TEXT,                            -- so a scorer change is auditable in the trend
  trigger        TEXT NOT NULL DEFAULT 'manual',  -- manual | scheduled | api | agent
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_site_time ON audits(site_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audits_org ON audits(org_id);

CREATE TABLE IF NOT EXISTS findings (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  audit_id    TEXT NOT NULL REFERENCES audits(id),
  site_id     TEXT NOT NULL REFERENCES sites(id),
  category    TEXT NOT NULL,                     -- crawler | ai | technical | social | performance
  severity    TEXT NOT NULL,                     -- critical | high | medium | low | info
  code        TEXT,                              -- stable check id (dedupe across runs)
  title       TEXT NOT NULL,
  detail      TEXT,
  fix_summary TEXT,
  status      TEXT NOT NULL DEFAULT 'open',      -- open | fixed | ignored
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_audit ON findings(audit_id);
CREATE INDEX IF NOT EXISTS idx_findings_site_status ON findings(site_id, status);

CREATE TABLE IF NOT EXISTS recommendations (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  site_id     TEXT NOT NULL REFERENCES sites(id),
  audit_id    TEXT REFERENCES audits(id),
  priority    INTEGER NOT NULL DEFAULT 3,        -- 1 = do first (action-first UX)
  title       TEXT NOT NULL,
  action      TEXT,                              -- machine-actionable intent (feeds the agent layer)
  impact      TEXT,                              -- why it matters
  effort      TEXT,                              -- low | medium | high
  status      TEXT NOT NULL DEFAULT 'suggested', -- suggested | accepted | applied | verified | dismissed
  applied_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recos_site_status ON recommendations(site_id, status, priority);

-- ── Competitor & AI-citation intelligence (over time) ─────────────────────
CREATE TABLE IF NOT EXISTS competitors (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id),
  site_id         TEXT NOT NULL REFERENCES sites(id),
  competitor_url  TEXT NOT NULL,
  competitor_host TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_competitors_site ON competitors(site_id);

CREATE TABLE IF NOT EXISTS citation_snapshots (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organizations(id),
  site_id              TEXT NOT NULL REFERENCES sites(id),
  engine               TEXT NOT NULL,            -- gemini | perplexity | chatgpt | google_aio | ...
  query                TEXT NOT NULL,
  brand_cited          INTEGER NOT NULL DEFAULT 0,
  domain_cited         INTEGER NOT NULL DEFAULT 0,
  position             INTEGER,
  competitors_named_json TEXT,                    -- who AI named instead of you
  observed_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citations_site_time ON citation_snapshots(site_id, observed_at);

-- ── Agent automation runs (the autonomous visibility team) ────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  site_id      TEXT REFERENCES sites(id),
  agent        TEXT NOT NULL,                    -- technical_auditor | citation_analyst | ...
  action       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  input_json   TEXT,
  output_json  TEXT,
  cost_credits INTEGER NOT NULL DEFAULT 0,       -- cost tracking (observability)
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_site ON agent_runs(site_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_org ON agent_runs(org_id);

-- ── Alerts (why customers come back = recurring revenue) ───────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id),
  site_id            TEXT REFERENCES sites(id),
  type               TEXT NOT NULL,              -- score_drop | competitor_overtook | citation_lost | audit_failed
  severity           TEXT NOT NULL DEFAULT 'info',
  message            TEXT NOT NULL,
  delivered_channels TEXT,                       -- csv: email,line
  created_at         TEXT NOT NULL,
  read_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_org_unread ON alerts(org_id, read_at);

-- ── Audit trail / events (enterprise observability) ───────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  org_id      TEXT,
  actor       TEXT,                              -- user email | agent id | system
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  meta_json   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_org_time ON events(org_id, created_at);

-- ── Human Outcome Stream (the business results customers pay for) ──────────
-- leads / calls / LINE adds / quotations / sales / revenue. The bridge from
-- visibility scores to revenue, and the most valuable stream in the dataset:
-- it makes "what generated revenue?" answerable.
CREATE TABLE IF NOT EXISTS outcomes (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  site_id     TEXT NOT NULL REFERENCES sites(id),
  type        TEXT NOT NULL,                     -- lead | line_add | phone_call | contact_form | quotation | meeting | sale | revenue
  value_cents INTEGER NOT NULL DEFAULT 0,        -- monetary value in satang (THB) where applicable
  currency    TEXT NOT NULL DEFAULT 'thb',
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',    -- manual | line | webform | api | ...
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_site_time ON outcomes(site_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_outcomes_org ON outcomes(org_id);
