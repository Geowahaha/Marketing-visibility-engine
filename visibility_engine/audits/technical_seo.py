"""
technical_seo.py
----------------
Checks the on-page technical signals that Google's 2026 core updates weigh most:
crawlability, mobile-first readiness, title/description quality, heading
hierarchy, canonical, HTTPS + security headers, structured data presence,
image alt coverage, and response speed (a Core Web Vitals proxy).

These are "table stakes" in 2026 — get them wrong and content quality can't
save you.
"""

from __future__ import annotations

import re

from ..crawler import FetchResult
from ..types import AuditResult, Severity, Status


def audit(result: FetchResult) -> AuditResult:
    r = AuditResult(category="Technical SEO (Google 2026)")
    if not result.ok or result.soup is None:
        r.add("Page reachable", Status.FAIL, Severity.CRITICAL,
              detail=f"Could not fetch page: {result.error or result.status}",
              fix="Confirm the URL resolves and returns HTTP 200.")
        return r
    soup = result.soup

    # --- HTTPS ---
    if result.url.startswith("https://"):
        r.add("HTTPS", Status.PASS, Severity.CRITICAL)
    else:
        r.add("HTTPS", Status.FAIL, Severity.CRITICAL,
              detail="Served over http. HTTPS is mandatory in 2026.",
              fix="Install a TLS certificate (Let's Encrypt is free) and 301-redirect all http to https.")

    # --- Title ---
    title = (soup.title.string or "").strip() if soup.title else ""
    if not title:
        r.add("Title tag", Status.FAIL, Severity.CRITICAL,
              fix="Add a unique <title> (50-60 chars) with the primary keyword near the front.")
    elif len(title) > 65:
        r.add("Title tag", Status.WARN, Severity.MEDIUM,
              detail=f"{len(title)} chars — likely truncated in SERPs.",
              fix="Trim to ~55-60 characters.")
    elif len(title) < 20:
        r.add("Title tag", Status.WARN, Severity.MEDIUM,
              detail=f"Only {len(title)} chars — under-using the slot.",
              fix="Expand to describe the page + brand, e.g. 'Sand Casting Services | Suphan Casting'.")
    else:
        r.add("Title tag", Status.PASS, Severity.CRITICAL, detail=title)

    # --- Meta description ---
    md = soup.find("meta", attrs={"name": "description"})
    desc = (md.get("content", "").strip() if md else "")
    if not desc:
        r.add("Meta description", Status.FAIL, Severity.HIGH,
              fix="Add a 140-160 char meta description that states the offer and invites the click.")
    elif not (120 <= len(desc) <= 170):
        r.add("Meta description", Status.WARN, Severity.MEDIUM,
              detail=f"{len(desc)} chars.", fix="Aim for 140-160 characters.")
    else:
        r.add("Meta description", Status.PASS, Severity.HIGH)

    # --- Mobile viewport (mobile-first indexing) ---
    if soup.find("meta", attrs={"name": "viewport"}):
        r.add("Mobile viewport", Status.PASS, Severity.CRITICAL)
    else:
        r.add("Mobile viewport", Status.FAIL, Severity.CRITICAL,
              detail="No viewport meta — fails mobile-first indexing.",
              fix='Add <meta name="viewport" content="width=device-width, initial-scale=1">.')

    # --- H1 ---
    h1s = soup.find_all("h1")
    if len(h1s) == 0:
        r.add("H1 heading", Status.FAIL, Severity.HIGH,
              fix="Add exactly one <h1> describing the page topic.")
    elif len(h1s) > 1:
        r.add("H1 heading", Status.WARN, Severity.MEDIUM,
              detail=f"{len(h1s)} H1s found.", fix="Use a single H1; demote the rest to H2/H3.")
    else:
        r.add("H1 heading", Status.PASS, Severity.HIGH, detail=h1s[0].get_text(strip=True)[:80])

    # --- Heading hierarchy ---
    headings = [int(h.name[1]) for h in soup.find_all(re.compile(r"^h[1-6]$"))]
    skips = [b for a, b in zip(headings, headings[1:]) if b - a > 1]
    if headings and not skips:
        r.add("Heading hierarchy", Status.PASS, Severity.LOW)
    elif skips:
        r.add("Heading hierarchy", Status.WARN, Severity.LOW,
              detail="Heading levels skip (e.g. H2 -> H4).",
              fix="Keep heading levels sequential for accessibility and parsing.")

    # --- Canonical ---
    if soup.find("link", attrs={"rel": "canonical"}):
        r.add("Canonical tag", Status.PASS, Severity.MEDIUM)
    else:
        r.add("Canonical tag", Status.WARN, Severity.MEDIUM,
              fix='Add <link rel="canonical" href="..."> to consolidate duplicate URLs.')

    # --- Structured data (JSON-LD) ---
    ld = soup.find_all("script", attrs={"type": "application/ld+json"})
    if ld:
        r.add("Structured data (JSON-LD)", Status.PASS, Severity.HIGH,
              detail=f"{len(ld)} JSON-LD block(s) found.")
    else:
        r.add("Structured data (JSON-LD)", Status.FAIL, Severity.HIGH,
              detail="No schema markup — hurts rich results and AI citation.",
              fix="Add JSON-LD (LocalBusiness / Organization / Product / FAQPage). Use the schema generator in this repo.")

    # --- Image alt coverage ---
    imgs = soup.find_all("img")
    if imgs:
        missing = [i for i in imgs if not i.get("alt", "").strip()]
        pct = 100 * (len(imgs) - len(missing)) // len(imgs)
        if pct >= 90:
            r.add("Image alt text", Status.PASS, Severity.LOW, detail=f"{pct}% covered")
        else:
            r.add("Image alt text", Status.WARN, Severity.LOW,
                  detail=f"{len(missing)}/{len(imgs)} images missing alt ({pct}% covered).",
                  fix="Add descriptive alt text to every meaningful image.")

    # --- Response speed (CWV proxy) ---
    ms = result.elapsed_ms
    if ms <= 800:
        r.add("Server response (TTFB proxy)", Status.PASS, Severity.HIGH, detail=f"{ms} ms")
    elif ms <= 1800:
        r.add("Server response (TTFB proxy)", Status.WARN, Severity.HIGH,
              detail=f"{ms} ms full-load.",
              fix="Enable caching/CDN; optimize images. Confirm with PageSpeed Insights field data.")
    else:
        r.add("Server response (TTFB proxy)", Status.FAIL, Severity.HIGH,
              detail=f"{ms} ms — slow.",
              fix="Investigate hosting, image weight, and render-blocking resources. Target 'Good' Core Web Vitals.")

    # --- Security header (HSTS) ---
    if any(k.lower() == "strict-transport-security" for k in result.headers):
        r.add("HSTS header", Status.PASS, Severity.LOW)
    else:
        r.add("HSTS header", Status.WARN, Severity.LOW,
              fix="Add Strict-Transport-Security header to enforce HTTPS.")

    return r
