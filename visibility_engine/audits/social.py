"""
social.py
---------
Two parts:

1. Link-preview audit (machine-checkable): Open Graph + Twitter Card tags. These
   control how the site looks when shared into Facebook/Messenger/LINE/X. A
   missing or broken preview kills click-through on social.

2. Facebook 2026 playbook (manual checklist surfaced in the report): organic
   Page reach now sits at ~1-6% of followers, so the algorithm rewards
   Meaningful Social Interactions (saves, shares-to-story, long comments) and
   native short video far more than likes. These are actions you take on the
   profile, so the tool reports them as a checklist rather than auto-scoring.
"""

from __future__ import annotations

from ..crawler import FetchResult
from ..types import AuditResult, Severity, Status

OG_REQUIRED = ["og:title", "og:description", "og:image", "og:url", "og:type"]

# 2026 Facebook/Meta organic-reach playbook (reported, not auto-scored)
FACEBOOK_PLAYBOOK = [
    "Complete the Business profile fully: logo profile pic, branded cover, contact, hours, services, and turn on 2FA — a complete, secure Page makes Meta route higher-quality users to you.",
    "Post native short vertical video / Reels — the single biggest organic discovery channel in 2026; never post a bare YouTube link (off-platform links are downranked).",
    "Optimise for Meaningful Social Interactions: a Save or a Share-to-Story is worth more than ~50 likes. Make save-worthy reference content (guides, spec sheets, checklists).",
    "Reply to every comment within the first 60 minutes — fast threaded replies are read by the algorithm as a high-value conversation and lift distribution.",
    "Keep to ~2 core content themes so Meta's AI can tag your audience; scattered topics dilute recommendation weight (it profiles your last ~9-12 posts).",
    "Never use engagement bait ('like & share!') — it's penalised. Earn comments with open questions, before/after reveals, and behind-the-scenes process clips.",
    "Follow the 80/20 rule: 80% value (process, tips, results), 20% promotion.",
    "Start a niche Facebook Group around your craft — Groups reach 20-40% of members vs 1-6% for Pages.",
    "Amplify via founder/employee personal profiles — taps networks a Page can't reach.",
    "Use top organic posts (most saves/shares) as the creative you later put ad budget behind.",
]


def audit(result: FetchResult) -> AuditResult:
    r = AuditResult(category="Social Sharing & Open Graph")
    if not result.ok or result.soup is None:
        r.add("Page reachable", Status.FAIL, Severity.CRITICAL, detail="Page not fetched.")
        return r
    soup = result.soup

    present = {}
    for tag in soup.find_all("meta", property=True):
        present[tag.get("property")] = tag.get("content", "")

    missing = [p for p in OG_REQUIRED if not present.get(p)]
    if not missing:
        r.add("Open Graph tags", Status.PASS, Severity.HIGH,
              detail="All core og: tags present — clean link previews.")
    else:
        sev = Severity.HIGH if "og:image" in missing or "og:title" in missing else Severity.MEDIUM
        r.add("Open Graph tags", Status.FAIL, sev,
              detail=f"Missing: {', '.join(missing)}.",
              fix="Add og:title, og:description, og:image (1200x630), og:url, og:type so shared links render with a rich card.")

    # Twitter / X card
    has_tw = soup.find("meta", attrs={"name": "twitter:card"}) is not None
    if has_tw:
        r.add("Twitter/X card", Status.PASS, Severity.LOW)
    else:
        r.add("Twitter/X card", Status.WARN, Severity.LOW,
              fix='Add <meta name="twitter:card" content="summary_large_image"> + twitter:title/description/image.')

    # og:image dimension hint
    if present.get("og:image") and not present.get("og:image:width"):
        r.add("og:image dimensions", Status.WARN, Severity.LOW,
              fix="Declare og:image:width=1200 and og:image:height=630 for reliable previews.")

    return r
