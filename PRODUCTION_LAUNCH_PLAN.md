# AI Mark — Project Total, Senior Review & Production Launch Plan

> Date: **2026-06-02** · Reviewer pass: senior engineer · Live: aimark.pages.dev
> Companion to `AIMARK_MISSION.md` (vision) and `GROWTH_ENGINE_PLAN.md` (strategy).
> Evidence base: live `/api/system-health`, `npm run verify:local` (all pass),
> `git status`, and a read of all 34 API functions + the Hermes bridge.

---

## 0. One-paragraph verdict

AI Mark is **further along than its own docs admit**. The full scan → fix →
apply → prove loop exists and runs; the live self-audit reports all five core
lanes (storage, auth, payments+PromptPay, proof, Hermes agent) ready; the local
verification gate passes end-to-end including the agent bridge. This is a
**core-production-ready** product, not a prototype. The work before a confident
public launch is **discipline, not features**: get the source under version
control + CI, rotate the leaked secret file, harden the few honest gaps, and
refactor Hermes toward a clean skill registry so new revenue lines ship in days.
Against a typical digital-marketing agency, AI Mark already wins on speed, price,
and proof — the gap to close is reliability and trust packaging.

---

## 1. Total the project — full inventory

### Front-end (`web/`)
| File | Role |
|---|---|
| `index.html` (~186 KB) | The main app: scan, fixes, competitor, content, proof, plans, credits, login. The product. |
| `agent.html` | Conversational xAI-style agent UI over the same APIs. |
| `agent-pair.html` | Hermes device-pairing screen. |
| `proof-demo.html`, `analytics.html`, `classic.html` | Proof showcase, before/after traffic, legacy UI. |

### API — 34 Cloudflare Pages Functions (~8,000 lines), grouped
- **Diagnose:** `scan.js` (806), `deep-scan.js`, `bot-access.js`, `bot-intel.js`
  (356), `render-check.js`, `social-visibility.js`, `citation-probe.js`,
  `answer-gap.js`, `competitor.js`.
- **Fix:** `improve.js` (589), `content-engine.js`, `line-oa-kit.js`.
- **Apply:** `deploy.js` (448), `agent-bridge.js`, `agent/*` (heartbeat, jobs
  poll/ack/progress/result/status, pair/device/approve/token).
- **Prove + money:** `proof.js` (681), `checkout.js` (472), `checkout/webhook.js`,
  `export-package.js`, `system-health.js` (294).
- **Distribution:** `lead-scout.js` (591).
- **Auth/integrations:** `auth/*` (Google/GitHub OAuth, me, logout),
  `github/*` (OAuth + GitHub App install, repo, connect-token), `analytics.js`,
  `watchtower-start.js`, `request-render.js`.
- **Shared libs:** `_llm.js` (multi-provider failover Anthropic→Groq→Kimi),
  `_auth.js` (sessions), `_credits.js` (credit ledger), `_agent.js` (Hermes
  pairing/tokens/queue), `_github.js`.

### Hermes (the execution layer)
- `scripts/aimark-local-bridge.mjs` (~69 KB) — pair, poll, run-via-local-runner,
  Playwright browser actions under capability gates, SSRF guards, workspace +
  post-back. **bridge e2e passes** in the verify gate.
- `scripts/aimark-verify-production.mjs` — the gate (syntax, API smoke, bridge
  e2e, Python audits, npm audit, optional production smoke).
- `scripts/` test/start helpers; `.aimark-agent/` runtime (inbox/outbox/runner/
  workspace, cloud token) with real executed jobs on disk.

### Python engine (`visibility_engine/`)
- Original heuristic auditor: FastAPI `api.py` + `web_adapter.py` + CLI +
  crawler + audits (ai_crawlers, geo_aeo, social, technical_seo) + fixers. Has
  tests + GitHub Actions CI + Dockerfile. **Role must be decided** (see §3).

### Storage / config
- KV: `RATE_LIMIT_KV`, `ENTITLEMENTS_KV` (credits/auth/agent fallback),
  `PROOF_KV`. Optional `AGENT_DB`/`AGENT_KV` (D1 supported in `_agent.js`).
- Secrets configured live (per self-audit): Stripe + webhook, Google OAuth,
  session secret, browser rendering, citation/lead providers, LLM keys.

---

## 2. Senior review — what's genuinely strong

1. **Deterministic scoring.** `scan.js` computes scores from a fixed rubric;
   the LLM only writes prose. Same site → same score regardless of model. This
   is the single most important design choice — it makes before/after **trustworthy**
   and survives switching LLM providers. Rare discipline; keep it.
2. **Honesty is enforced in code, not just policy.** Citation probes report
   *observed* presence; performance is labeled "Lite" without a PSI key; the
   self-audit refuses to claim "ready" until lanes are actually configured.
3. **A self-auditing production endpoint** (`system-health.js`) that distinguishes
   core-ready vs optional. Most startups never build this; it is exactly how you
   avoid "it's done" when it isn't.
4. **Real apply lanes, not mock-ups.** GitHub PR (with hub + sitemap + internal
   links in one PR) and a Cloudflare injector. The bridge already shipped client
   content.
5. **Safety is real.** SSRF guards, same-site enforcement, least-privilege
   capability gating, device-code pairing, HMAC-signed agent tokens, no secret
   pasting, idempotent credit debits.
6. **A complete revenue path** — credits ledger + Stripe + PromptPay + webhook +
   promo codes — wired and live, not a "coming soon."
7. **The verify gate exists and passes**, including an end-to-end agent test.

## 2b. Risks & technical debt (honest — fix before scale)

| # | Risk | Severity | Why it matters | Action |
|---|---|---|---|---|
| R1 | **Most new code is uncommitted** (`git status`: `improve.js`, `checkout.js`, `_credits.js`, `lead-scout.js`, `system-health.js`, entire `agent/`, etc. are untracked). | **Critical** | The live product depends on files that exist only on one laptop. One disk loss = the company is gone. No CI, no review, no rollback. | Commit everything now; push; protect `main`; deploy from CI. |
| R2 | **`/.env.local.txt`** is a plaintext dump of ~15 live keys (GitHub PAT, Cloudflare/R2, Aiven MySQL, Namecheap, Anthropic, FB/LINE/Telegram, TikTok). Not git-tracked, but on disk. | **Critical** | Any leak compromises everything. | Rotate all keys; replace with placeholders; store real secrets only in Cloudflare/secret manager. |
| R3 | **Skill dispatch is implicit** (regex on job `kind` across cloud + bridge + UI + pricing). | High | Adding a skill = editing 4 places; easy to ship a skill that's sellable but not executable, or vice-versa. | Build the skill registry from `AIMARK_MISSION.md` §Hermes. |
| R4 | **Hermes runs on the owner's single Windows machine.** | High (for managed scale) | Key-person / single point of failure; can't serve many managed clients concurrently. | Containerize the runner; run a small hosted fleet for managed tier; keep local bridge for self-serve/white-label. |
| R5 | **Two engines** (Python `visibility_engine/` + JS Functions). | Medium | Drift, double maintenance, unclear source of truth. | Declare the JS Functions the product; keep Python as offline/batch/CI auditor or retire it. Document the decision. |
| R6 | **LLM currently on Groq** (Anthropic monthly cap). | Medium | Groq is more lenient/vague; mitigated because scoring is deterministic, but prose quality varies. | Restore Anthropic as primary post-reset; keep failover; add a 3rd valid fallback (re-issue Kimi). |
| R7 | **`index.html` is a 186 KB monolith**; limited automated test coverage beyond smoke/e2e. | Medium | Hard to change safely; regressions slip. | Add a few Playwright UI smoke tests to the gate; consider extracting JS modules incrementally. |
| R8 | **No legal/trust surface** (Terms, Privacy, refund policy, data handling). | Medium | Required for paid + OAuth + Thai PDPA; blocks trust at scale. | Add ToS/Privacy/refund pages before broad paid launch. |

---

## 3. Production readiness matrix (live, 2026-06-02)

| Lane | Status | Notes |
|---|---|---|
| Storage & abuse control (KV) | ✅ Ready | 3 KV bound. |
| Auth / login + repo approval | ✅ Ready | Google login + GitHub App lane. |
| Payments + PromptPay | ✅ Ready | Stripe live + webhook + PromptPay. |
| Proof loop + screenshot | ✅ Ready | Baseline + Browser Rendering. |
| Hermes agent bridge | ✅ Ready | Pair/poll/result; e2e passes. |
| Verified PageSpeed/CWV | ◻️ Optional | Needs `GOOGLE_PSI_KEY`; "Performance Lite" works without it. |
| **Verify gate** (`verify:local`) | ✅ Pass | syntax, api smoke, bridge e2e, python audits, npm audit. |

**Decision rule (keep using it):** do not tell a customer "done" until
`system-health` shows the relevant lane ready **and** the matching smoke check in
the runbook passes for their account.

---

## 4. Go-live checklist (the last mile — do in order)

**Tier 0 — must do before inviting paying strangers**
1. **Commit + push everything**, protect `main`, set up CI to run `verify:local`
   on every push, and **deploy from CI** (not from the laptop). *(closes R1)*
2. **Rotate every key** in `.env.local.txt`; delete the plaintext values; verify
   nothing secret is git-tracked. *(closes R2)*
3. Add **Terms, Privacy, refund** pages + a PDPA-aware data note. *(closes R8)*
4. Run the full **`npm run verify:production`** against the live URL and the five
   runbook smoke checks (login, checkout+webhook credit, agent pair→result,
   proof render, scan with/without PSI). Record the results.

**Tier 1 — strongly recommended within the first week**
5. Add `GOOGLE_PSI_KEY` so Core Web Vitals are verified, not "Lite." *(optional lane)*
6. Restore Anthropic primary + a valid third LLM fallback. *(R6)*
7. Decide and document the Python engine's role. *(R5)*
8. Add 2–3 Playwright UI smoke tests (scan renders, checkout opens, pairing) to
   the gate. *(R7)*

**Tier 2 — the scaling unlock (weeks 2–4)**
9. Ship the **Hermes skill registry** (manifest-driven). *(R3)*
10. Containerize a **hosted Hermes runner** for the managed tier. *(R4)*

---

## 5. Pricing & monetization review

The shift to a **credits** model is the right call: it matches usage to cost,
removes the binary paywall friction, and lets every new skill price itself via
`_credits.js`. Recommendations:
- Keep a **generous free scan** (the lead magnet that already converts curiosity).
- Anchor a **starter credit pack** that comfortably covers "one full fix + one
  proof re-scan" — that first end-to-end "aha" is the conversion engine.
- Make **PromptPay** the default for Thai checkout (it removes card friction).
- Layer a **Growth subscription** (monthly re-scan + citation probe + competitor)
  for recurring revenue, and **Managed/White-label** on top.
- Show **credit cost on every action chip** so there are no surprises (and so it
  reinforces "this does real work").

---

## 6. Go-to-market / startup plan

**ICP (who pays first):** Thai SMEs and service businesses already spending on
ads/Facebook/LINE, with a structurally weak site (thin content, blocked AI bots,
no schema/FAQ, weak OG) and no technical team. The casting/foundry and local
B2B niches already in the workspace (successcasting, suphancasting, pinpoint)
are the proof beachhead.

**Motion (the flywheel from the mission):**
`lead-scout` finds an evidence-backed prospect → send the **real scan screenshot +
one concrete money leak** (≤20/day, personalized, not spam) → free 5-minute scan →
credits buy the fix → **Hermes applies it** → proof loop shows the lift →
subscription + new skills retain → referrals.

**30 / 60 / 90:**
- **0–30:** Close Tier-0 checklist. Land 5–10 paying SMEs manually via lead-scout
  evidence outreach. Capture before/after proof for each — this is the marketing.
- **30–60:** Ship the skill registry + 1–2 new revenue skills (ads-waste audit,
  Google Business Profile fixer). Stand up the hosted runner. Turn proofs into
  public case studies (with consent).
- **60–90:** Recruit 2–3 agencies onto a white-label pilot. Launch the Growth
  subscription. Start the longitudinal "AI share-of-voice" benchmark dataset.

---

## 7. Better than a digital-marketing agency — the explicit benchmark

| Dimension | Typical agency | AI Mark |
|---|---|---|
| Time to first result | Days–weeks (kickoff, audit, deck) | **Minutes** (scan + generated fix) |
| Deliverable | A report / recommendations | **The artifact itself + applied via PR/deploy** |
| Proof | "Trust us / vanity metrics" | **Deterministic before/after + AI-citation probe** |
| AI-search readiness (GEO/AEO) | Rarely covered | **Core competency** (bot access, schema, llms.txt, answer-first content) |
| LINE OA conversion | Separate vendor | **Built in** (kit + agent brief) |
| Price | Retainer (hours) | **Credits / subscription (software margin)** |
| Scale | Linear in headcount | **Compounds per skill; white-label to agencies** |
| Honesty | Often over-promises ranking | **Refuses to promise; proves instead** |

**Where agencies still win today (close these):** relationship/trust packaging,
strategy nuance, and reliability guarantees. AI Mark closes them with the proof
loop, professional UI, case studies, ToS/SLA, and the managed tier — without
giving up the speed/price/proof advantages above.

---

## 8. What "done" means for this launch

Done is **not** "the features exist" (they do). Done is:
source in version control + CI, secrets rotated, legal pages live, the full
production verify gate + five smoke checks green against the live URL, and the
first paying SMEs with **before/after proof on record**. Track it; do not call it
done until each line is true.
