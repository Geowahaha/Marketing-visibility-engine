# Deploy — Visibility Engine Web (Cloudflare Pages)

A one-page AI website-visibility scanner. Front-end (`index.html`) + a
server-side scan endpoint (`functions/api/scan.js`) that fetches the target
site and calls the Claude API. Free to host on Cloudflare Pages.

## What you need
- A Cloudflare account (free).
- An Anthropic API key (`sk-ant-...`) from console.anthropic.com.
- Node.js installed (for the `wrangler` CLI).

## Deploy in 4 commands (PowerShell)
```powershell
cd web
npx wrangler login                      # opens browser, authorize once
npx wrangler pages deploy . --project-name visibility-engine
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name visibility-engine
```
The last command prompts you to paste your key — it is stored **encrypted** in
Cloudflare and never appears in the code or the browser. Optionally set the
model:
```powershell
npx wrangler pages secret put CLAUDE_MODEL --project-name visibility-engine
# then type e.g.  claude-opus-4-8   (default is claude-sonnet-4-6)
```
After deploy you get a live URL like `https://visibility-engine.pages.dev`.
Re-deploy anytime by re-running the `pages deploy` line.

## Rate limiting (do this before going public)
Each scan is a paid Claude call, so cap scans per visitor. Create a KV namespace
and bind it as `RATE_LIMIT_KV`:
```powershell
npx wrangler kv namespace create RATE_LIMIT_KV
# copy the returned id, then in the dashboard: Pages project → Settings →
# Functions → KV namespace bindings → add  RATE_LIMIT_KV = <that id>
```
Default is 5 scans/IP/hour. Change with a `RATE_LIMIT_MAX` variable. If the
binding is absent the app still runs but is unprotected (fail-open).

## Before/After analytics (/analytics.html)
You already have a zone + token. Add two secrets so the page can query your
Cloudflare GraphQL Analytics:
```powershell
npx wrangler pages secret put CF_API_TOKEN --project-name visibility-engine
npx wrangler pages secret put CF_ZONE_TAG  --project-name visibility-engine
```
- `CF_API_TOKEN` needs **Analytics → Read** permission for the zone.
- `CF_ZONE_TAG` is the Zone ID (dashboard → your domain → Overview → Zone ID).
The page pulls page views / requests / unique visitors for a "before" and an
"after" window and shows the % change — client-ready proof of improvement.

> If you'd rather use the dashboard: Workers & Pages → Create → Pages → connect
> the GitHub repo, set the build output directory to `web`, and add
> `ANTHROPIC_API_KEY` under Settings → Variables and Secrets.

## Local preview
```powershell
cd web
npm install
$env:ANTHROPIC_API_KEY="sk-ant-..."     # for the dev session only
npx wrangler pages dev .
```

## Traffic analytics for client before/after  ← your use-case
Turn on **Cloudflare Web Analytics** (free, privacy-first, no cookie banner):
Cloudflare dashboard → your Pages project → **Metrics / Web Analytics** → enable.
You get visits, page views, referrers, countries, top paths, and **real Core
Web Vitals** — perfect for showing a client a before/after once you ship fixes.
Note the date you enable it; that's your "before" baseline.

### Cloudflare Pages vs Vercel (quick answer)
- **Hosting**: Both have generous free tiers. Cloudflare Pages: *unlimited*
  bandwidth/requests, 500 builds/month. Vercel free: 100 GB bandwidth/month.
- **Analytics for before/after**: Cloudflare Web Analytics is free and richer
  (Core Web Vitals + traffic) with no cookie consent needed. Vercel's free
  analytics is more limited and some traffic detail needs a paid plan. For
  client-facing before/after dashboards, **Cloudflare is the better pick.**

## Core Web Vitals & PDF export
The scan auto-pulls real Core Web Vitals (LCP/INP/CLS, mobile) from Google
PageSpeed Insights — works with no key, but add `GOOGLE_PSI_KEY` for higher quota:
```powershell
npx wrangler pages secret put GOOGLE_PSI_KEY --project-name visibility-engine
```
Every report has a **Download PDF** button (browser "Save as PDF" with a clean
light print layout) — ready to hand to a client.

## How it works
1. Browser POSTs `{ url, prompt }` to `/api/scan`.
2. The Function fetches the target's homepage, robots.txt, sitemap.xml and
   llms.txt server-side (no CORS), and extracts title/meta/OG/canonical/schema.
3. It sends those real signals + your prompt to Claude, which returns a strict
   JSON audit (four pillars, findings, action plan, footprint).
4. The page renders that JSON into the dashboard.

## Limitations & notes
- Some sites block datacenter IPs (Cloudflare's included). If the target 403s,
  the scan still runs and reports the block as a finding (that *is* signal).
- Backlink authority isn't free-scannable — wire an Ahrefs/Majestic/Moz key if
  you want that panel populated.
- Cost: each scan is one Claude API call (a few cents on Sonnet). Add your own
  rate-limiting if you make the page public.
