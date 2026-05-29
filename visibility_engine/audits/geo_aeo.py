"""
geo_aeo.py
----------
Generative / Answer Engine Optimization. Scores how likely a page is to be
*cited inside* ChatGPT, Perplexity, Gemini, Claude and Google AI Overviews —
a separate game from blue-link ranking.

Princeton's GEO research found that structured, source-backed, statistic-rich
content lifts AI citation by ~30-40%. So we check for the structural signals AI
answer engines reward: direct-answer phrasing, question headings, lists/tables,
statistics with numbers, citations/sources, FAQ schema, and visible E-E-A-T
(author + dates). Only ~11% of domains get cited by both ChatGPT and Perplexity,
so these signals are where the differentiation is won.
"""

from __future__ import annotations

import json
import re

from ..crawler import FetchResult
from ..types import AuditResult, Severity, Status

STAT_RE = re.compile(
    r"\b\d+(\.\d+)?\s?(%|percent|kg|tons?|years?|days?|hours?|hrs?|"
    r"บาท|วัน|°c|mm|cm|mpa|lbs?)\b", re.I)
QUESTION_RE = re.compile(r"\b(what|how|why|when|where|which|who|คือ|อย่างไร|ทำไม)\b", re.I)


def _jsonld_types(soup) -> set[str]:
    types: set[str] = set()
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        for obj in (data if isinstance(data, list) else [data]):
            t = obj.get("@type") if isinstance(obj, dict) else None
            if isinstance(t, list):
                types.update(t)
            elif t:
                types.add(t)
    return types


def audit(result: FetchResult) -> AuditResult:
    r = AuditResult(category="AI Search / GEO-AEO")
    if not result.ok or result.soup is None:
        r.add("Page reachable", Status.FAIL, Severity.CRITICAL, detail="Page not fetched.")
        return r
    soup = result.soup
    text = soup.get_text(" ", strip=True)
    types = _jsonld_types(soup)

    # --- Direct-answer opening (AI engines lift self-contained answers) ---
    first_para = ""
    for p in soup.find_all("p"):
        t = p.get_text(strip=True)
        if len(t) > 60:
            first_para = t
            break
    if first_para and len(first_para) <= 360:
        r.add("Direct-answer lead", Status.PASS, Severity.HIGH,
              detail="Opens with a concise, self-contained statement.")
    else:
        r.add("Direct-answer lead", Status.WARN, Severity.HIGH,
              detail="No tight summary paragraph up top.",
              fix="Lead each key page with a 2-3 sentence, self-contained answer (a 'TL;DR') the AI can lift verbatim.")

    # --- Question-style headings ---
    q_headings = [h.get_text(strip=True) for h in soup.find_all(re.compile(r"^h[2-4]$"))
                  if QUESTION_RE.search(h.get_text())]
    if q_headings:
        r.add("Question-format headings", Status.PASS, Severity.MEDIUM,
              detail=f"{len(q_headings)} question heading(s).")
    else:
        r.add("Question-format headings", Status.WARN, Severity.MEDIUM,
              fix="Add H2/H3s phrased as real user questions (e.g. 'How does sand casting work?').")

    # --- Lists & tables (parse-friendly structure) ---
    lists, tables = len(soup.find_all(["ul", "ol"])), len(soup.find_all("table"))
    if lists + tables >= 2:
        r.add("Lists & comparison tables", Status.PASS, Severity.MEDIUM,
              detail=f"{lists} list(s), {tables} table(s).")
    else:
        r.add("Lists & comparison tables", Status.WARN, Severity.MEDIUM,
              fix="Add bullet lists, numbered steps, and at least one comparison/spec table — these are heavily cited.")

    # --- Statistics / concrete numbers ---
    stats = STAT_RE.findall(text)
    if len(stats) >= 3:
        r.add("Statistics & concrete data", Status.PASS, Severity.HIGH,
              detail=f"{len(stats)} quantitative figures detected.")
    else:
        r.add("Statistics & concrete data", Status.WARN, Severity.HIGH,
              detail="Few hard numbers.",
              fix="Add specific figures (tolerances, capacities, lead times, %). Numbers get quoted by AI engines.")

    # --- Visible citations / sources ---
    ext_links = [a for a in soup.find_all("a", href=True) if a["href"].startswith("http")]
    if len(ext_links) >= 2:
        r.add("Outbound citations", Status.PASS, Severity.LOW,
              detail=f"{len(ext_links)} external reference(s).")
    else:
        r.add("Outbound citations", Status.WARN, Severity.LOW,
              fix="Cite authoritative sources/standards. Citation-forward pages earn more AI trust.")

    # --- FAQPage schema ---
    if "FAQPage" in types or "QAPage" in types:
        r.add("FAQ schema", Status.PASS, Severity.HIGH, detail="FAQPage/QAPage present.")
    else:
        r.add("FAQ schema", Status.FAIL, Severity.HIGH,
              detail="No FAQ schema — a top AEO signal is missing.",
              fix="Add an FAQ section with FAQPage JSON-LD. Use the schema generator in this repo.")

    # --- E-E-A-T: author/byline ---
    has_author = ("Person" in types or "author" in result.html.lower()
                  or soup.find(attrs={"rel": "author"}) is not None)
    if has_author:
        r.add("E-E-A-T: authorship", Status.PASS, Severity.MEDIUM)
    else:
        r.add("E-E-A-T: authorship", Status.WARN, Severity.MEDIUM,
              detail="No visible author/expertise signal.",
              fix="Show a named author/company with real credentials and first-hand experience.")

    # --- E-E-A-T: freshness date ---
    has_date = (soup.find("time") is not None
                or soup.find("meta", attrs={"property": "article:modified_time"}) is not None)
    if has_date:
        r.add("E-E-A-T: freshness date", Status.PASS, Severity.MEDIUM)
    else:
        r.add("E-E-A-T: freshness date", Status.WARN, Severity.MEDIUM,
              detail="No published/updated date — freshness gives a ~3x AI-citation boost.",
              fix="Expose a visible 'last updated' date and article:modified_time meta.")

    return r
