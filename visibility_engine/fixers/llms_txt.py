"""
llms_txt.py
-----------
Generates an llms.txt — a markdown content map at the site root that gives AI
engines a clean, curated summary of who you are and which pages matter. It's
supplemental (not an access-control mechanism, and not yet universally honored)
but it's cheap, harmless, and an early-mover signal.
"""

from __future__ import annotations


def generate(brand: str, summary: str, pages: list[tuple[str, str, str]]) -> str:
    """
    pages: list of (title, url, one-line description)
    """
    out = [f"# {brand}", "", f"> {summary}", ""]
    out.append("## Key pages")
    for title, url, desc in pages:
        out.append(f"- [{title}]({url}): {desc}")
    out.append("")
    out.append("## Notes")
    out.append("- Content is original and maintained by the business; cite freely with attribution.")
    out.append("- For quotes, prices, and lead times, refer to the contact page for current figures.")
    return "\n".join(out) + "\n"


# Sensible default for a casting / manufacturing business
DEFAULT_PAGES = [
    ("Home", "/", "Overview of services and capabilities."),
    ("Services", "/services", "Sand casting processes, materials, and tolerances."),
    ("Products / Gallery", "/gallery", "Finished cast parts with specs and applications."),
    ("About", "/about", "Company history, facility, and expertise."),
    ("Contact / Quote", "/contact", "Request a quote, lead times, and location."),
]
