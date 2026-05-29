# visibility-engine

A runnable audit-and-improve toolkit for **website + AI-search + social visibility**, built around the **2026** ranking landscape. Point it at a URL and it scores four layers, tells you exactly what to fix, and generates the files you drop straight onto the server.

Built for [suphancasting.com](https://suphancasting.com) but works on any site.

---

## Why these four layers

Search split in two. There's classic Google ranking, and there's a new layer — AI answer engines (ChatGPT, Perplexity, Gemini, Claude, Google AI Overviews) — sitting on top of it. As of Q1 2026 those engines handle an estimated 12–18% of informational queries (up from under 2% a year earlier), and AI Overviews cut click-through on top Google results sharply. So the tool audits both, plus the plumbing that decides whether AI bots can even read you, plus social link-rendering.

| Layer | What it checks | 2026 basis |
|---|---|---|
| **Technical SEO** | HTTPS, mobile viewport, title/description, H1 + heading hierarchy, canonical, JSON-LD presence, image alt, response speed, HSTS | Google's March + May 2026 core updates made E-E-A-T, Core Web Vitals, and mobile-first *table stakes* |
| **GEO / AEO** | direct-answer lead, question headings, lists/tables, statistics, citations, FAQ schema, author + freshness date | Princeton research: structured, source-backed, stat-rich content lifts AI citation ~30–40%. Only ~11% of domains are cited by both ChatGPT and Perplexity |
| **AI crawler access** | robots.txt allow/deny for OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot, Google-Extended; sitemap; llms.txt | ~41% of business sites still accidentally block a major AI bot; each blocked bot costs an estimated 18–34% of citations on that engine |
| **Social / Open Graph** | og: + Twitter card tags (link previews) + a Facebook 2026 organic-reach playbook | Page reach is now ~1–6%; Meta rewards Meaningful Social Interactions, native video, fast replies |

---

## Install

```powershell
git clone <your-repo-url> visibility-engine
cd visibility-engine
python -m venv .venv
.\.venv\Scripts\Activate.ps1      # Windows PowerShell
pip install -r requirements.txt
```

## Usage

**Audit a site** (crawl the homepage, or `--pages N` to walk internal links), and save a Markdown report:

```powershell
python -m visibility_engine audit https://suphancasting.com --pages 5 --out report.md
```

You get a colored console scorecard, per-category grades, and a `report.md` containing a severity-ordered action plan plus the Facebook playbook.

**Generate the fix files** (print to stdout; redirect to a file):

```powershell
# Optimal 2026 AI-visibility robots.txt
python -m visibility_engine generate-robots https://suphancasting.com > robots.txt

# llms.txt content map for AI engines
python -m visibility_engine generate-llms "Suphan Casting" "Sand casting factory in Nakhon Ratchasima" --domain https://suphancasting.com > llms.txt

# LocalBusiness + FAQPage JSON-LD (paste into <head>)
python -m visibility_engine generate-schema --name "Suphan Casting" --domain https://suphancasting.com --description "Custom sand casting" --city "Nakhon Ratchasima" --region "Nakhon Ratchasima" --country TH
```

## Run the tests

```powershell
pytest -q
```

---

## Project layout

```
visibility_engine/
├── crawler.py            # polite fetch + internal-link discovery
├── types.py              # Finding / AuditResult + severity scoring
├── audits/
│   ├── technical_seo.py  # Google 2026 on-page signals
│   ├── geo_aeo.py        # AI-citation readiness
│   ├── ai_crawlers.py    # robots.txt / sitemap / llms.txt
│   └── social.py         # Open Graph + Facebook playbook
├── fixers/
│   ├── robots_txt.py     # generate AI-visibility robots.txt
│   ├── llms_txt.py       # generate llms.txt
│   └── schema.py         # generate JSON-LD
├── report.py             # console + Markdown output
└── cli.py                # command-line interface
tests/test_audits.py      # offline test suite
samples/sample_page.html  # fixture
```

## Scoring

Each category starts at 100. Failing or warning checks subtract a weight by severity (critical 30 / high 18 / medium 9 / low 4; warnings cost half). The overall score is the mean across categories, mapped to A–F. The numbers are a relative health gauge to track improvement over time — not an official Google score.

## Caveats

- **Response time is a TTFB *proxy*.** For real Core Web Vitals (LCP/INP/CLS) use Google PageSpeed Insights field data — the tool tells you when to.
- **robots.txt is advisory.** Some crawlers ignore it; if you ever need to *block* abusive bots, do it at the server/WAF level.
- **The Facebook playbook is a manual checklist** — those are actions on the Page itself, not things the crawler can verify.
- **GEO checks are structural heuristics.** They measure whether content is *shaped* to be cited; they can't measure your actual citation share. Track that by running target queries through the AI engines weekly.
