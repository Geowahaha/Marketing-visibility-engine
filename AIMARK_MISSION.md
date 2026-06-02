# AI Mark Mission

> Live: **aimark.pages.dev** · Repo: `Geowahaha/Marketing-visibility-engine` ·
> Umbrella: **Blutenstein** · Updated: 2026-06-02 (senior review pass)

## Mission

AI Mark exists to help SMEs stop burning scarce capital on marketing that does
not convert — and to actually *fix* the leak, not just report it.

Most owners pay for ads, SEO, and social, then send that attention to a website
and LINE that AI engines cannot read, cannot cite, and that does not convert.
AI Mark closes the whole loop:

**Scan → Diagnose → Generate the real fix → Apply it (with the owner's
approval) → Prove the lift with before/after evidence → Keep monitoring.**

For Thai customers, AI Mark is **web + AI visibility + LINE OA conversion**, run
by a non-technical owner — not a pretty website alone, and not another dashboard
that tells you what's wrong and leaves you stuck.

## The core belief

> **Every finding must ship with the fix already generated.** A non-technical
> owner should never be told "add JSON-LD." They should be handed the JSON-LD,
> shown exactly where it goes (or have us apply it), and watch the score rise.

That single principle is the difference between a *scanner* (a commodity) and a
*growth engine* (a business). It is what makes AI Mark better than a digital
marketing agency: agencies sell hours and reports; AI Mark ships outcomes with
proof, at software margins, in minutes.

---

## What AI Mark is **now** (June 2026 — honest current state)

The scan→fix→apply→prove loop is built and live. This is no longer a plan; it is
a running product. (Full inventory and senior review: `PRODUCTION_LAUNCH_PLAN.md`.)

**Diagnosis engines (read the truth about a site):**
- `scan.js` — deterministic, model-independent scoring (HTTPS, title/meta, word
  count, schema, robots, sitemap, AI-bot blocking, OG, PSI). Same site → same
  score, so before/after is trustworthy. LLM only writes the prose.
- `deep-scan.js` — whole-site crawl + per-page rollup + site-wide gaps.
- `bot-access.js` / `bot-intel.js` — live per-bot crawl test (GPTBot, ClaudeBot,
  PerplexityBot, Googlebot…): served vs blocked vs robots vs login-wall.
- `render-check.js` — human-vs-AI render diff (Browser Rendering).
- `social-visibility.js` — real public signals per channel, deterministic score.
- `citation-probe.js` / `answer-gap.js` — ask the real AI engines a buyer's
  question and detect whether the brand is named. The metric customers care about.
- `competitor.js` — scan target + competitors, show the gap and which fix closes it.

**Fix engines (produce the actual artifacts):**
- `improve.js` — head/OG, JSON-LD, AI robots.txt, llms.txt, AEO FAQ block,
  30-day social calendar, LINE OA kit. Ready to paste or deploy.
- `content-engine.js` — real buyer questions (SerpAPI PAA + Tavily) → query map,
  answer-first content plan, publish-ready articles with FAQPage schema, entity
  & backlink plan.
- `line-oa-kit.js` — rich menu, welcome/quick replies, draft broadcasts, agent brief.

**Apply lanes (make it real):**
- `deploy.js` — GitHub PR lane (commit robots/llms/head + publish content pages,
  with hub + sitemap + internal links in one PR) and Cloudflare Worker injector.
- `agent-bridge.js` + `agent/*` — the **Hermes** job queue (see below).

**Prove + monetize:**
- `proof.js` — per-account before/after, baseline diff, public proof link.
- `checkout.js` (+ `checkout/webhook.js`) + `_credits.js` — a **credits** model:
  Stripe card (recurring) and **PromptPay QR** (Thai), webhook-recorded credit
  ledger in KV, idempotent debits per feature, promo codes.
- `system-health.js` — a live production self-audit endpoint that reports which
  revenue/proof/agent/repo lanes are actually configured. (No guessing.)

**Distribution engine:**
- `lead-scout.js` — finds outreach-ready SME prospects with evidence and a
  personalized first message. It does not spam; it builds a prioritized,
  evidence-backed queue.

**Status (from the live `/api/system-health` + `npm run verify:local`, 2026-06-02):**
All five core lanes — storage, auth/login, payments+PromptPay, proof loop, and
the Hermes agent bridge — report **ready**. The local gate passes syntax, API
smoke, **bridge end-to-end**, Python audits, and npm-audit. The only optional
gap is a keyed PageSpeed quota (`GOOGLE_PSI_KEY`). The product is
**core-production-ready**; what remains is the last-mile launch discipline in
`PRODUCTION_LAUNCH_PLAN.md`, not missing features.

---

## The Hermes goal (added 2026-06-02)

Hermes is the **execution layer** — the messenger that actually does the work on
the customer's stack. Today it is `scripts/aimark-local-bridge.mjs`: it pairs to
the cloud with a device code, polls the job queue, runs each job through a local
runner (Claude Code / Codex — so we are not blocked by cloud LLM rate limits),
can drive a real browser (Playwright) under capability gates, writes results to
a workspace, and posts them back. It has already executed real client jobs
(e.g. successcasting.com content pages).

**The mandate: make Hermes light, fast, and able to gain new skills smoothly —
and make each finished skill genuinely complete, not a demo.**

Three principles, in priority order:

1. **Light** — the bridge stays a thin, dependency-minimal runtime. It owns
   *transport, safety, and proof*; the *thinking* is the runner's. No heavy
   framework. Cold-start fast, runs on a laptop, optional browser only when a
   skill needs it.
2. **Fast** — poll → claim → run → report with minimal latency. Stream progress
   so the owner sees motion. Cache aggressively (PSI, scans). Deterministic
   scoring so re-runs are cheap and comparable.
3. **Smoothly extensible (the real engineering target)** — adding a new skill
   must be a *one-place, contract-driven* change, not a hunt through regexes.

### Skill architecture (the refactor that unlocks "add skills smoothly")

Today a "skill" is implicit: job `kind` strings are matched by regex in several
places (cloud `kind`, bridge `normalizeApprovedActions`, UI action chips, credit
cost table). Adding one means editing all of them — that is the friction the
owner felt. The target is a **single skill manifest** that every layer reads:

```
Skill = {
  id,                       // "content_page", "line_oa_kit", "ads_audit"
  label, label_th,          // UI + i18n
  input_contract,           // required scan facts / fields (validated up front)
  output_contract,          // shape the UI + proof loop expect back
  capabilities: [...],      // what Hermes may do: public_http_fetch,
                            //   browser_snapshot, github_pr, cf_deploy, line_draft
  runner_prompt,            // the template handed to the local runner
  credit_cost,              // pulled into _credits.js automatically
  proof: { baseline, recheck }  // how "before/after" is captured for this skill
}
```

One registry, four automatic wirings:
- **Cloud** routes the job by `id` (no new regex).
- **Hermes** grants exactly the declared `capabilities` (least privilege) and
  runs the `runner_prompt` — unknown skills are simply rejected, not mis-handled.
- **UI** renders the action chip + i18n label from the manifest.
- **Pricing** reads `credit_cost` so monetization is never forgotten.

When this exists, a new skill (ads-waste audit, Google Business Profile fixer,
review-response writer, product-feed/schema for e-commerce, GA4 insight digest)
is **one manifest file + one runner prompt**, and it lights up end-to-end:
sellable, executable, and proof-tracked. That is "add skills smoothly and
complete perfect work" made concrete. This is the next architectural milestone.

### Hermes safety contract (keep, non-negotiable)
- **Least-privilege capabilities** per skill; the owner approves the action set.
- **SSRF guards**: no private networks; targets must be the approved site or a
  subdomain.
- **No secret pasting** into AI Mark's web box. Repo access via GitHub App /
  OAuth; LINE tokens stay in the owner's own LINE tools / local MCP.
- **Human-in-the-loop apply**: Hermes proposes a PR / draft; a human ships it.
- **Proof, not promises** (see Guardrails).

---

## Something bigger — the future we are actually building

The visibility scanner was the wedge. The asset is **Hermes + the proof loop +
a Thai SME distribution channel.** Read that way, four larger businesses open up:

1. **Hermes as the universal "hands" for SMEs.** Once a safe, skill-pluggable
   local executor can read a business's site, social, LINE, and repo and *act*
   with approval, AI Mark is no longer a visibility tool — it is the agent that
   *runs* the small business's digital presence. Visibility is skill #1. Ads
   hygiene, reviews, content, e-commerce feeds, local SEO, and reporting are
   skills #2…n on the same rails.

2. **A skill marketplace / agency-in-a-box.** Every new manifest is a new
   revenue line at software margin. We can ship them ourselves, and eventually
   let trusted partners author skills against the same safety contract. The
   product compounds instead of plateauing.

3. **White-label for agencies (Blutenstein infra play).** Agencies sell hours
   and can't scale; AI Mark gives them scan→fix→prove→report under their own
   brand. We stop competing with every local agency and instead become the
   engine *underneath* them — many resellers, one platform.

4. **A proof / "AI share-of-voice over time" data moat.** Every scan, citation
   probe, and before/after is a longitudinal dataset on how Thai SMEs appear to
   AI engines. Honest, repeated, comparable. Nobody else has that for this
   market. It powers benchmarks, retention, and eventually an industry index.

**The flywheel:** lead-scout finds SMEs with a real, screenshot-able leak →
free scan proves it → credits buy the fix → Hermes applies it → proof loop shows
the lift → monitoring + new skills retain → happy owners and agencies refer.
More usage → more proof data → sharper diagnosis → better fixes → more usage.

---

## Revenue model (credits-first)

Self-serve credits, with a managed/white-label tier on top. Credit costs live in
`_credits.js` (e.g. export 100, render-check 75, proof 50, LINE kit 100,
deploy/apply 150). Payments are Stripe **card (recurring)** + **PromptPay QR**
(one-time, Thai-first), with promo codes for unlocks.

| Offer | Use case | Direction |
|---|---|---|
| Free Scan | Lead magnet, diagnosis screenshot | Free |
| Credit packs | Pay-as-you-go fixes/proofs/deploys | Self-serve, software margin |
| Growth subscription | Monthly re-scan, citation probe, competitor track, proof | Recurring |
| Managed Growth | We run it: fixes deployed, content, social, reporting | High-margin |
| White-label | Agencies resell scan→fix→prove under their brand | Platform/infra |

---

## Guardrails (keep — these are the brand)

- Never promise guaranteed Google ranking, guaranteed AI citation, or guaranteed
  revenue. Citation probes report **observed** presence at probe time only; we
  measure **readiness** and **prove before/after**.
- Never ask customers to paste GitHub/Google/LINE/payment secrets into an
  untrusted box. Use official OAuth / GitHub App / device-code flows.
- LINE OA tokens stay in LINE's own tools or the customer's local MCP config.
- Hermes acts only within approved capabilities and the approved site; a human
  approves anything that ships.
- Keep the UI honest and professional: no fake metrics, no AI-slop emoji decor.

## Research sources

- WARC (global ad market): https://www.warc.com/
- Gartner 2025 CMO Spend Survey: https://www.businesswire.com/news/home/20250602746568/en/
- SparkToro/Datos zero-click 2024 (Search Engine Land): https://searchengineland.com/google-search-zero-click-study-2024-443869
- OECD Thailand SME profile: https://www.oecd.org/en/publications/financing-smes-and-entrepreneurs-2026_075d8058-en/full-report/thailand_a1b1b4e6.html
- DataReportal Digital 2025 Thailand (LINE 56M MAU): https://datareportal.com/reports/digital-2025-thailand
- Competitor refs: Ahrefs Brand Radar, Semrush AI Visibility Toolkit, Evertune, Peec AI, OtterlyAI.
- line-oa-mcp-ultimate: https://github.com/Geowahaha/line-oa-mcp-ultimate.git
