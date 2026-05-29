"""
Offline tests — no network. Builds FetchResult objects from inline HTML and
asserts the audits flag what they should. Run with:  pytest -q
"""

from bs4 import BeautifulSoup

from visibility_engine.audits import ai_crawlers, geo_aeo, social, technical_seo
from visibility_engine.crawler import FetchResult
from visibility_engine.fixers import llms_txt, robots_txt, schema
from visibility_engine.types import Status


def _fr(html: str, url="https://example.com", ms=500, headers=None):
    return FetchResult(url=url, status=200, ok=True, elapsed_ms=ms,
                       html=html, headers=headers or {}, soup=BeautifulSoup(html, "lxml"))


GOOD = """<!doctype html><html lang="th"><head>
<title>Sand Casting Services in Korat | Suphan Casting</title>
<meta name="description" content="Suphan Casting offers custom sand casting in aluminium, brass and bronze with 7-14 day lead times and tolerances to 0.5mm for industrial clients in Thailand.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://example.com/">
<meta property="og:title" content="Suphan Casting">
<meta property="og:description" content="Custom sand casting">
<meta property="og:image" content="https://example.com/c.jpg">
<meta property="og:url" content="https://example.com/">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>
</head><body>
<h1>Sand Casting Services</h1>
<p>Suphan Casting is a sand-casting factory in Nakhon Ratchasima producing aluminium, brass and bronze parts with 0.5mm tolerance and 14 day lead times.</p>
<h2>How does sand casting work?</h2>
<ul><li>Pattern making</li><li>Molding</li></ul>
<table><tr><td>Aluminium</td><td>660°C</td></tr></table>
<time datetime="2026-05-01">Updated May 2026</time>
<a href="https://standards.org">ISO reference</a>
<img src="a.jpg" alt="cast part">
</body></html>"""

BAD = """<!doctype html><html><head><title>Hi</title></head>
<body><h1>x</h1><p>short</p><img src="a.jpg"></body></html>"""


def test_good_page_scores_high():
    assert technical_seo.audit(_fr(GOOD)).score() >= 85
    assert geo_aeo.audit(_fr(GOOD)).score() >= 80
    assert social.audit(_fr(GOOD)).score() >= 90


def test_bad_page_flags_critical():
    tech = technical_seo.audit(_fr(BAD, ms=2500))
    checks = {f.check: f.status for f in tech.findings}
    assert checks["Mobile viewport"] == Status.FAIL
    assert checks["Meta description"] == Status.FAIL
    assert checks["Structured data (JSON-LD)"] == Status.FAIL
    assert tech.score() < 40


def test_geo_detects_faq_and_stats():
    geo = geo_aeo.audit(_fr(GOOD))
    checks = {f.check: f.status for f in geo.findings}
    assert checks["FAQ schema"] == Status.PASS
    assert checks["Statistics & concrete data"] == Status.PASS
    assert checks["Question-format headings"] == Status.PASS


def test_robots_blocking_detection():
    blocking = "User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /"
    assert ai_crawlers._blocks(blocking, "GPTBot") is True
    assert ai_crawlers._blocks(blocking, "PerplexityBot") is False


def test_fixers_produce_output():
    assert "GPTBot" in robots_txt.generate("https://x.com")
    assert "PerplexityBot" in robots_txt.generate("https://x.com")
    assert "# Suphan" in llms_txt.generate("Suphan", "desc", [("Home", "/", "d")])
    assert "FAQPage" in schema.faq_page([("q", "a")])
    assert "LocalBusiness" in schema.local_business("n", "u", "d")
