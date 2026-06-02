# AI Mark → Growth Engine: Strategy, Product & Business Model

> **Mission:** People pay a lot for ads and visibility but their site/social still
> don't convert and AI engines don't cite them. AI Mark must stop being *just a
> scanner* and become a **one-click, done-for-you growth engine** that a
> non-technical owner can run to actually *fix* their website and social — and
> that we can charge for, repeatably.

---

## 1. The problem we're really solving (2026 reality)

The market shifted under our customers' feet, and they're still paying for the
old world:

- **~60% of Google searches now end with no click** — AI Overviews, ChatGPT,
  Perplexity and Gemini answer directly. Agencies report **30–70% organic
  traffic drops** even when rankings are flat.
- Owners keep **buying ads and SEO** that send people to a page AI engines can't
  read, can't cite, and that doesn't convert. The money leaks twice: ad spend in,
  no organic citation pickup, weak conversion out.
- The new #1 position is **being cited inside the AI answer**, not ranking #1 on
  a page of blue links. Most SME sites are structurally invisible to that layer
  (no schema, no FAQ/answer blocks, no `llms.txt`, blocked AI bots, thin OG).

**Who pays:** SMEs and local/service businesses (our Thai-first base —
suphancasting, successcasting, etc.) who already spend on ads/Facebook/LINE but
have no technical team to fix the plumbing.

**Pricing reality (validates willingness to pay):**

| Tier in the wild | Monthly price | What you get |
|---|---|---|
| DIY AI-visibility tools | $200–$1,000 | Monitoring/scanning only |
| Mid-market GEO/AEO retainer | $2,000–$8,000 | Strategy + content |
| Enterprise GEO | $15,000–$30,000+ | Dedicated team |

Almost all of it is **monitoring**. **The gap = done-for-you fixing for people
with no technical knowledge.** That's our wedge.

---

## 2. The product shift: Scanner → Fixer → Growth Engine

Today the codebase does three of the five stages. The money is in stages 3–5.

| Stage | What it does | Status today | Where it lives |
|---|---|---|---|
| 1. **Scan** | Read site + robots/sitemap/llms + CWV, score it | ✅ Done | `web/functions/api/scan.js` |
| 2. **Diagnose** | Prioritized findings + action plan | ✅ Done | `export-package.js` |
| 3. **Generate fixes** | Produce the *actual* artifacts (meta, schema, robots, llms, FAQ, social posts) | 🔨 **Building now** | `web/functions/api/improve.js` (new) |
| 4. **Apply / 1-click** | Push fixes live (hosted sites) or give a paste-once bundle + agent handoff | ◻️ Next | `agent-bridge.js` (handoff exists) + deploy connectors |
| 5. **Monitor & prove** | Re-scan, before/after, competitor + AI-citation tracking | ◻️ Partial | `api.py` Growth Monitor + new probes |

> The principle: **every finding must come with the fix already generated.** A
> non-technical owner should never be told "add JSON-LD" — they should be handed
> the JSON-LD, told exactly where to paste it (or we paste it for them), and shown
> the score go up.

---

## 3. The "one-click, no technical knowledge" experience

```
Paste your link  →  Scan (free)  →  See score + top fixes (free)
      →  "Fix it for me" (paid)  →  Improve Engine generates everything
      →  Apply:  (a) Auto-deploy if we host / have access
                 (b) One paste-bundle + 3-step guide
                 (c) Hand to AI agent (agent-bridge) to implement
      →  Re-scan → before/after proof → keep monitoring (subscription)
```

Three "apply" lanes because owners arrive with different setups:

- **Lane A — Managed/hosted:** we connect Cloudflare/Vercel/GitHub (tokens already
  in their stack) and deploy the fixes. True one-click.
- **Lane B — Self-serve paste:** we output a single `<head>` block + uploadable
  `robots.txt`/`llms.txt`/`sitemap` + an FAQ section, with a dead-simple "paste
  this here" guide and a screenshot. No code knowledge needed.
- **Lane C — Agent handoff:** `agent-bridge.js` already packages the job for an AI
  agent / our team to implement end-to-end (the white-glove upsell).

---

## 4. Deeper analysis (so it's not "just a scanner")

Add real signal, not more surface checks:

1. **AI-citation probe** — actually ask the AI engines a buyer's question
   ("best sand casting factory in Nakhon Ratchasima") and detect whether the
   brand is named/cited. This is the metric customers actually care about, and the
   honest version of "share of answer." (Uses Gemini/Claude/Perplexity APIs.)
2. **Competitor benchmark** — scan 1–3 competitors on the same axes; show the gap
   and exactly which fixes close it. Comparison sells.
3. **Content & entity gap** — what questions/topics buyers ask that the site never
   answers (the AEO content roadmap).
4. **Conversion read** — is there a clear offer, proof, and a contact/booking path
   above the fold? Ads are wasted without it.
5. **Social depth** — per-platform (FB/IG/TikTok/YouTube/LINE) role + concrete
   30-day calendar, not a generic checklist (`social-visibility.js` is the seed).
6. **LINE OA conversion layer** — Thai SMEs already close deals in LINE, so the
   website fix must hand off into rich menu, welcome message, quick replies,
   broadcasts, coupon/CRM ideas, and safe agent execution. AI Mark now generates
   `line_oa_growth_kit` from `/api/improve`; the customer does not paste LINE
   tokens into AI Mark.

> **Honesty guardrail (keep it):** never claim exact AI ranking or guaranteed
> citation. We measure *readiness* + *observed* presence, and we *prove* before/
> after. This is already enforced across `api.py`/`web_adapter.py` — keep it.

---

## 5. Business model — how this makes real money

Productized, mostly self-serve, with a managed upsell. Names below map to
`public_visibility_packages()` in `web_adapter.py` (update them to match).

| Tier | Price (THB, illustrative) | Promise | Lane |
|---|---|---|---|
| **Free Scan** | ฿0 | 1 scan, score, top 5 fixes (no artifacts) | — Lead magnet |
| **Fix Pack** (one-time) | ฿1,900–3,900 | Improve Engine: full generated artifacts + paste guide + 1 re-scan proof | B/C |
| **Growth Monitor** (subscription) | ฿990–2,900 / mo | Monthly re-scan, AI-citation probe, competitor track, fresh content ideas, before/after | A/B |
| **Managed Growth** | ฿9,900+ / mo | We do everything: fixes deployed, content, social calendar executed, reporting | A/C |

**Why this works:**
- Free scan = top-of-funnel lead magnet (already converts the curious).
- Fix Pack = low-friction first purchase; the "aha" is seeing real artifacts +
  the score jump. This is the conversion engine.
- Growth Monitor = recurring revenue; the AI-citation + competitor tracking is
  the reason to keep paying.
- Managed = high-margin agency tier under the Blutenstein umbrella.

**Payments (Thai-first):** PromptPay / Thai card via **Stripe** or **Omise**,
plus **LINE Pay** (our audience lives on LINE). Gate the Improve Engine and
export behind a paid token/cookie — the gating hook already exists
(`PAID_EXPORT_SECRET`, `aimark_paid_export` cookie). Wire a `/api/checkout` that,
on payment webhook, mints that token. Login (Google/GitHub) scaffolding is
already present for account binding.

---

## 6. Roadmap (sequenced for revenue, not vanity)

**Phase 1 — Turn scans into money (this sprint)**
- [x] Scan + diagnose (done).
- [ ] **Improve Engine** `/api/improve` — generate real artifacts. *(building)*
- [ ] Free preview (1 artifact) + paid full unlock — drives the first purchase.
- [ ] "Fix it for me" CTA in the UI after every scan.

**Phase 2 — Make payment & proof real**
- [ ] `/api/checkout` (Stripe/Omise/LINE Pay) → mints paid token on webhook.
- [ ] Store scans per account; show before/after re-scan automatically.
- [ ] Competitor benchmark in the scan response.

**Phase 3 — Deeper analysis & retention**
- [ ] AI-citation probe (Gemini/Claude/Perplexity) — the headline metric.
- [ ] Growth Monitor scheduler live (cron → `/growth-monitor/run-due`).
- [ ] Per-platform social calendar generator.

**Phase 4 — True one-click apply (Lane A)**
- [ ] Cloudflare/Vercel/GitHub deploy connectors for hosted clients.
- [ ] Agent-bridge → autonomous implementation + verify + report.

---

## 7. What we are building right now

`web/functions/api/improve.js` — the **Improve Engine**. It takes a completed
scan and uses Claude to generate, tailored to the actual site content:

1. Optimized `<head>` block (title, meta description, canonical, lang, viewport,
   full Open Graph + Twitter card).
2. JSON-LD schema (Organization/LocalBusiness + FAQPage).
3. AI-tuned `robots.txt` (allow the AI search bots, keep sitemap line).
4. `llms.txt` content map.
5. An **AEO answer/FAQ HTML block** that directly answers buyer questions — the
   single biggest lever for getting cited by AI.
6. A **30-day social content calendar** derived from the site's real services.
7. A **LINE OA Growth Kit** for Thai customers: rich menu brief, welcome/quick
   reply copy, draft broadcasts, auto-reply rules, and an agent prompt for
   `line-oa-mcp-ultimate`.

Each artifact ships with: *what it fixes*, *where to paste it*, and *how to
verify*. Free tier returns a preview (the `<head>` block); paid unlocks the
full artifact set plus the deployable bundle. This is the product people pay for.

---

## 8. LINE OA add-on (Thai wedge)

LINE is not a side channel in Thailand. DataReportal's Digital 2025 Thailand
report says LINE had **56 million monthly active users** in Thailand in early
2025, equal to **85.7% of internet users**. LINE's own help center says Official
Accounts support targeted broadcasts, Messaging API integration, and one-to-one
or group messaging, while verified OA review is available in Thailand.

AI Mark should use that reality as a wedge:

- Website fix = makes Google/AI/social previews understand the business.
- LINE OA Growth Kit = turns that visibility into chat, quote, repeat purchase,
  and retention.
- Agent bridge = lets our operator or the customer's local agent execute setup
  without exposing secrets to AI Mark's web app.

The studied repo `https://github.com/Geowahaha/line-oa-mcp-ultimate.git`
already covers the hard agent surface: message sending with draft/dry-run,
rich menu build/upload/default, Flex templates, audience tools, insights,
coupon/report tools, webhook testing, multi-OA support, LIFF utilities, and Thai
festival resources. Our job is not to rebuild that first; our job is to generate
the right customer-specific brief and route it to a trusted local/agent runtime.
