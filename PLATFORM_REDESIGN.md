# AI Mark — Platform Redesign Blueprint
### From "visibility scanner" to "AI Visibility Intelligence Platform"
_Founder/CTO blueprint. Status: design (Phase 0). Set via /goal 2026-06-08._

> **DO NOT BUILD another SEO checker. Build a visibility operating system.** — and
> **do not rewrite the thing that already works.** Both are true at once; this doc
> reconciles them.

---

## 0. The one decision that matters most (CTO challenge to the brief)

You asked me to challenge the framework. Here is the honest part first.

**The #1 risk is not architecture — it's strategic schizophrenia.** Two visions are
running in parallel in this repo:
- **AI Visibility SaaS** (this goal): measure/compare/improve/automate visibility.
- **Agent Civilization OS** (last goal): villages, karma, economy, citizens.

If you build both as separate cathedrals you will finish neither. **Pick the wedge,
subordinate the rest:**

> **The Visibility Platform is the product and the revenue. The agent village is the
> delivery engine** — it is *how* audits and fixes get done autonomously and cheaply.
> Sell visibility outcomes to businesses; the "village" is your back office, not a
> second product. Market the agents as *"your autonomous visibility team,"* never as
> a civilization SKU.

**The #2 risk is the rewrite instinct.** The framework (multi-tenant, queues,
microservices, "production-grade backend") reads like a ground-up rebuild. That is
the classic startup killer. You already have, **live and monetized**:
- a **deterministic scoring engine** (same input → same score → trustworthy
  before/after) — a real moat,
- a working **proof loop**, **payments**, an **MCP** tool server, and an **agent
  bridge** that executes real fixes.

**Evolve, don't replace.** The single change that turns "scanner → platform" requires
**zero new infrastructure**: use the **D1 database you already have** (binding
`AGENT_DB`, db `aimark-agent`) **relationally** instead of as a key/value shim.

### What your framework is missing (add these)
1. **Visibility Score time-series + per-site history.** You list "Visibility Score
   Growth" as a metric but there is nowhere to store it. The trend chart *is* the
   retention hook and the thing customers screenshot. → `audits` table (built below).
2. **Alerting / notifications.** "Your AI visibility dropped 12 pts; competitor X now
   gets cited and you don't." This is the *reason customers log back in* and the
   trigger that justifies a subscription. Email + LINE. Currently absent.
3. **The data moat / industry benchmarks.** Aggregate anonymized scores by industry →
   *"bottom 20% of Thai accounting firms for AI visibility."* Nobody else has Thai
   AI-visibility data. This is your defensibility — the framework omits it.
4. **A scheduler for "continuous monitoring."** Listed as an objective with no
   mechanism. → Cloudflare **Cron Triggers + Queues** (a small Worker beside Pages).
5. **Recurring-revenue reconciliation.** North star says recurring; product is
   one-time **credits**. Resolve as **two SKUs**: *monitoring subscription per
   site/month = MRR*; *credits = one-off heavy actions* (deploy/fix/render).
6. **Kill the second engine.** The Python `visibility_engine/` (~1.8k LOC) duplicates
   the live JS scorers. Two scorers **will drift** and destroy the deterministic
   moat. Freeze Python to an offline/reference tool; the edge functions are the
   single source of truth.

---

## 1. Current-State Audit (ground truth, from the code)

| Area | Reality today | Verdict |
|---|---|---|
| **Compute** | Cloudflare Pages, project `aimark`, **83 JS functions** in `web/functions/api` | Keep — edge-native, global, cheap |
| **Two engines** | Live **JS** functions **+** legacy **Python** `visibility_engine/` (CLI + FastAPI + audits/fixers) | **Debt** — freeze Python, one scorer |
| **Storage** | KV: `RATE_LIMIT_KV`, `ENTITLEMENTS_KV` (credits), `PROOF_KV`. **D1 `aimark-agent` bound but used as a KV shim** (`_agent.js d1Kv`) | **Biggest lever** — use D1 relationally |
| **History** | Before/after lives in `PROOF_KV`; **no per-site score time-series** | **#1 platform gap** |
| **Auth** | Cookie session (Google OAuth) + HMAC tokens (paid/agent/citizen/session). **Email-scoped, single-user** | No orgs/RBAC/API-keys yet |
| **Intelligence** | Deterministic scoring; tech/conversion/local/social audits; citation probe (Gemini/Perplexity/Tavily/SerpAPI); per-bot crawl test; MCP contract | **Strong** — maps to L1–L6 |
| **Automation** | Hermes bridge + resident agents + village/karma/**economy (L7 shipped this session)** + MCP | Maps to L8 + the Agents list |
| **Monetization** | Credits (one-time) + agent-hire economy | Add **subscriptions for MRR** |
| **Observability** | `system-health` lanes only; no structured logs/metrics/tracing/cost | Enterprise gap |
| **UX** | 6+ HTML pages (`index`, `agent`, `cockpit`, `classic`, `analytics`) + a **v7 React app at `/os`** | **Fragmented** — unify to one app |
| **CI/CD** | `verify:local` gate (syntax/api-smoke/bridge/piano/python/npm-audit) → auto-deploy on merge to main | **Excellent** — keep, extend |

**Production Readiness Score (current) — see §8.**

---

## 2. Target Architecture (evolutionary, not a rewrite)

```
                         ┌─────────────────────────────────────────────┐
  Browser / API client → │  Cloudflare Pages (web/functions/api/*)      │  ← KEEP
                         │  - REST + /api/mcp (MCP server)              │
                         │  - cookie/OAuth + NEW: org context + API keys│
                         └───────────────┬─────────────────────────────┘
                                         │
        ┌────────────────────────────────┼──────────────────────────────┐
        │                                 │                              │
   ┌────▼─────┐                    ┌──────▼───────┐               ┌──────▼──────┐
   │  D1 (NEW │                    │ KV (KEEP)     │               │ Deterministic│
   │  relational core)  ← system   │ rate-limit,   │               │ scorers (KEEP│
   │  orgs/projects/sites/audits/  │ sessions,     │               │ scan/tech/   │
   │  findings/recos/competitors/  │ credits,      │               │ conversion/  │
   │  citations/agent_runs/alerts/ │ cache, proof  │               │ local/social)│
   │  events                       └──────────────┘               └──────────────┘
   └────┬─────┘
        │
   ┌────▼──────────────────────────┐     ┌──────────────────────────────┐
   │ Monitoring Worker (NEW)        │     │ Agent layer (KEEP/EVOLVE)     │
   │ Cron Triggers + Queues:        │     │ Hermes bridge + residents +   │
   │ scheduled re-audit → write     │────▶│ MCP. The 7 named agents are   │
   │ audit row → diff → ALERT       │     │ roles over existing tools.    │
   └────────────────────────────────┘     └──────────────────────────────┘
                  │
            ┌─────▼──────┐
            │ Notify (NEW)│  email + LINE  → the recurring-revenue heartbeat
            └────────────┘
```

**Principles honored:** API-first (REST + MCP already), event-driven (audit→diff→alert
→agent), modular services (functions + worker), queue-based (Queues), scalable storage
(D1 + KV), observability-first (events/agent_runs.cost + structured logs).

**The 7 named agents are roles, not new code:** Technical Auditor = `tech-audit`,
Citation Analyst = `citation-probe`/`answer-gap`, Competitor Hunter = `competitor`,
Content Strategist = `content-engine`, Schema Optimizer = part of tech/improve, Social
Advisor = `social-visibility`, Verification Agent = `proof`. Wrap, don't rebuild.

---

## 3. Database Schema

Shipped as executable DDL: **`web/migrations/0001_platform_core.sql`** (validated,
14 tables / 17 indexes). Core entities: `organizations, users, memberships (RBAC),
api_keys, projects, sites, audits (the score time-series), findings, recommendations,
competitors, citation_snapshots, agent_runs (with cost), alerts, events (audit trail)`.
Everything is `org_id`-scoped from day one. Apply:

```
cd web && npx wrangler d1 migrations apply aimark-agent --local   # then --remote
```

The existing `d1Kv()` key/value table (`agent_store`) stays untouched and coexists —
no migration of current village data required.

---

## 4. UI Wireframes (one app, 10 modules, action-first)

**Onboarding (≤2 clicks to value):**
```
┌ Connect your site ───────────────────────────┐
│  [ paste URL ............... ]   (Run audit)  │
│  Google sign-in · or continue as guest        │
└───────────────────────────────────────────────┘  → first audit runs → Dashboard
```

**Executive Dashboard (the home):**
```
┌ AI VISIBILITY SCORE ─────────────┐  ┌ Trend (90d) ───────────────┐
│        72  ▲ +6 this week         │  │   ╱╲      ╱──               │
│  Search 80 · AI 61 · Social 70    │  │ ╱    ╲╱╲╱                   │
└───────────────────────────────────┘  └────────────────────────────┘
┌ Do these 3 first (action-first) ──────────────────────────────────┐
│ 1 ▸ Add FAQPage schema      impact:high  effort:low   [Fix for me] │
│ 2 ▸ Unblock GPTBot in robots impact:high effort:low   [Fix for me] │
│ 3 ▸ Publish 'pricing' page   impact:med  effort:med   [Draft it]   │
└────────────────────────────────────────────────────────────────────┘
┌ Competitors ────────────┐ ┌ AI Citations ──────┐ ┌ Alerts ─────────┐
│ you 72 · acclime 88 ▲   │ │ cited 1/8 queries  │ │ ⚠ score -12 Mon │
└─────────────────────────┘ └────────────────────┘ └─────────────────┘
```

**Left nav = the 10 core modules:** Dashboard · Projects · Sites · Audits ·
Competitors · AI Citations · Recommendations · Automation · Reports · Agents · Billing.
Mobile: nav collapses; the Score + "Do these 3 first" stack first. Reuse the `/os`
React app (Vite+React+TS+Tailwind+shadcn) as the shell — do not start a new frontend.

---

## 5. Migration Plan (incremental, each phase ships green behind the verify gate)

- **Phase 0 — now:** this blueprint + `0001_platform_core.sql` (validated). No runtime change.
- **Phase 1 — relational core:** apply schema; add `web/functions/api/_db.js` (thin
  D1 domain layer); on `ensureOrgForSession()` create org/user/membership lazily on
  first login. **Dual-write:** `/api/scan` ALSO inserts an `audits` row + `findings`
  (non-breaking; KV paths untouched).
- **Phase 2 — platform surface:** `/api/projects`, `/api/sites`, `/api/sites/:id/audits`
  (history) reading from D1; wire the Dashboard trend chart. Now it is a platform.
- **Phase 3 — continuous monitoring + alerts:** Monitoring Worker (Cron + Queue) re-audits
  monitored sites → diff vs last `audits` row → write `alerts` → email/LINE. Flip the
  `monitoring_enabled` switch behind a **subscription** (MRR).
- **Phase 4 — org/RBAC/API-keys + benchmarks:** memberships UI, `api_keys`, cohort
  benchmark query over `audits.scores_json` by `sites.industry`.
- **Phase 5 — enterprise hardening:** rate-limit per org, audit-trail UI (`events`),
  security review, cost dashboard (`agent_runs.cost_credits`).

**One phase per session** (credits are scarce — the cathedral-spire rule).

---

## 6. Risk Analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| Big-rewrite stalls the live product | High | **Evolve**; dual-write; never break working KV paths |
| Two scorers drift → moat lost | High | **Freeze Python**; edge functions are the only scorer |
| Scope creep / credit burn | High | One phase/session; verify gate each time |
| Multi-tenant data leakage | Med | `org_id` on every table + query + api-smoke tests for isolation |
| D1 write limits / single-region | Low (now) | Fine at scale today; add read-replica/caching later |
| Strategic split (two products) | High | Subordinate the village as the delivery engine |
| Notification spam → churn | Med | Threshold + digest; user-set alert sensitivity |

---

## 7. Implementation Roadmap (sequenced to revenue, not to completeness)

1. **History & trend** (Phase 1–2) — converts scanner→platform; unlocks retention. _← do first_
2. **Monitoring + alerts + subscription** (Phase 3) — turns retention into **MRR**.
3. **Recommendations workflow + "Fix for me"** wired to the agent layer (L7→L8) — adoption metric.
4. **Benchmarks / data moat** (Phase 4) — defensibility + a viral hook.
5. **Org/RBAC/API-keys → enterprise** (Phase 4–5) — only when a paying account asks.

**North-star metric to instrument first:** _Visibility Score Growth per monitored
site_ — it predicts retention and is the headline of every report.

---

## 8. Production Readiness Score

Honest dual framing (rubric 0–10):

| Dimension | As a live single-user scanner | As the enterprise platform vision |
|---|---|---|
| Core scanning/scoring | 8 | 8 |
| Reliability / CI-CD | 7 | 7 |
| Data persistence / history | 3 | **2** |
| Multi-tenancy | 2 | **2** |
| Auth / RBAC | 5 | 3 |
| Observability | 3 | 3 |
| Billing / MRR | 5 | 4 |
| UX coherence | 4 | 4 |
| Security | 5 | 5 |
| Automation / monitoring | 4 | 3 |
| **Overall** | **≈ 6.8 / 10** (a solid live tool) | **≈ 4.1 / 10** (early platform) |

**Reading:** you have a genuinely good *product*; you are early as a *platform*. The
gap is almost entirely **persistence + multi-tenancy + monitoring**, all unlocked by
the relational core in §3 — not by a rewrite.

---

## 9. Recommended first build (the wedge)

**Phase 1: the relational audit-history core + persist every scan.** Smallest change
that earns the word "platform" (history → trend → retention) and unlocks monitoring,
alerts, benchmarks, and the dashboard. Schema is ready (§3). Next session: apply it,
add `_db.js`, dual-write `/api/scan`, and surface a `/api/sites/:id/audits` trend.
