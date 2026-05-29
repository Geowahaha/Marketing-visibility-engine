"""
ai_crawlers.py
--------------
Audits whether AI engines are even *allowed* to read the site. In Q1 2026, ~41%
of business sites still accidentally block at least one major AI bot — usually a
leftover from the 2023-24 "block everything" panic — and each blocked bot costs
an estimated 18-34% of potential citations on that engine.

For a brand selling products/services (not a publisher protecting IP), the
correct posture is: ALLOW the search/retrieval + user-fetch bots. We check the
search-driving agents specifically, plus sitemap and llms.txt presence.
"""

from __future__ import annotations

from urllib.parse import urlparse

from ..crawler import Crawler
from ..types import AuditResult, Severity, Status

# bots that DRIVE AI VISIBILITY (search index + live citation fetch). Blocking
# these makes a brand invisible inside the corresponding AI engine.
VISIBILITY_BOTS = [
    "OAI-SearchBot",   # powers ChatGPT search results
    "ChatGPT-User",    # live fetch when a user clicks a ChatGPT citation
    "PerplexityBot",   # Perplexity search index
    "Claude-SearchBot",  # Anthropic search / citation
    "Google-Extended", # Gemini / AI Overviews generative access
]


def _blocks(robots_text: str, agent: str) -> bool:
    """True if the named agent (or a global *) is disallowed from root."""
    lines = [ln.strip() for ln in robots_text.splitlines()]
    current_agents: list[str] = []
    blocked_by_specific = None
    blocked_by_global = False
    for ln in lines:
        if not ln or ln.startswith("#"):
            continue
        low = ln.lower()
        if low.startswith("user-agent:"):
            val = ln.split(":", 1)[1].strip()
            # group boundary: reset when a UA line follows a directive
            current_agents = [val]
        elif low.startswith("disallow:"):
            path = ln.split(":", 1)[1].strip()
            if path == "/":
                for a in current_agents:
                    if a == agent:
                        blocked_by_specific = True
                    elif a == "*":
                        blocked_by_global = True
        elif low.startswith("allow:"):
            path = ln.split(":", 1)[1].strip()
            if path == "/" and agent in current_agents:
                blocked_by_specific = False
    if blocked_by_specific is not None:
        return blocked_by_specific
    return blocked_by_global


def audit(base_url: str, crawler: Crawler) -> AuditResult:
    r = AuditResult(category="AI Crawler Access")
    parsed = urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"

    # --- robots.txt ---
    status, robots = crawler.fetch_text(f"{root}/robots.txt")
    if status != 200 or not robots.strip():
        r.add("robots.txt present", Status.WARN, Severity.MEDIUM,
              detail="No robots.txt found.",
              fix="Add a robots.txt that explicitly allows AI bots and references your sitemap. Generate one with this repo.")
    else:
        r.add("robots.txt present", Status.PASS, Severity.MEDIUM)
        for bot in VISIBILITY_BOTS:
            if _blocks(robots, bot):
                r.add(f"AI bot allowed: {bot}", Status.FAIL, Severity.HIGH,
                      detail=f"{bot} is disallowed — you are invisible to that engine.",
                      fix=f"Add 'User-agent: {bot}\\nAllow: /' to robots.txt.")
            else:
                r.add(f"AI bot allowed: {bot}", Status.PASS, Severity.HIGH)
        if "sitemap:" in robots.lower():
            r.add("Sitemap referenced in robots", Status.PASS, Severity.LOW)
        else:
            r.add("Sitemap referenced in robots", Status.WARN, Severity.LOW,
                  fix="Add 'Sitemap: <root>/sitemap.xml' to robots.txt.")

    # --- sitemap.xml ---
    s_status, _ = crawler.fetch_text(f"{root}/sitemap.xml")
    if s_status == 200:
        r.add("sitemap.xml present", Status.PASS, Severity.MEDIUM)
    else:
        r.add("sitemap.xml present", Status.WARN, Severity.MEDIUM,
              fix="Publish an XML sitemap listing all indexable URLs.")

    # --- llms.txt (supplemental AI content map) ---
    l_status, _ = crawler.fetch_text(f"{root}/llms.txt")
    if l_status == 200:
        r.add("llms.txt present", Status.PASS, Severity.LOW,
              detail="Machine-readable content map published.")
    else:
        r.add("llms.txt present", Status.INFO, Severity.LOW,
              detail="Optional but emerging. Not an access-control mechanism.",
              fix="Publish /llms.txt as a curated map of your key pages. Generate one with this repo.")

    return r
