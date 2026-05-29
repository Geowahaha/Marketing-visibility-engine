"""
cli.py
------
Command-line interface.

    python -m visibility_engine audit https://suphancasting.com [--pages 5] [--out report.md]
    python -m visibility_engine generate-robots https://suphancasting.com
    python -m visibility_engine generate-llms  "Suphan Casting" "Sand casting factory..."
    python -m visibility_engine generate-schema --config config.yaml
"""

from __future__ import annotations

import argparse
import sys

from .audits import ai_crawlers, geo_aeo, social, technical_seo
from .crawler import Crawler
from .fixers import llms_txt, robots_txt, schema
from .report import console, to_console, to_markdown


def cmd_audit(args: argparse.Namespace) -> None:
    crawler = Crawler()
    console.print(f"[cyan]Crawling[/cyan] {args.url} (up to {args.pages} page(s))...")
    pages = crawler.crawl(args.url, max_pages=args.pages)
    home = pages[0]

    results = [
        technical_seo.audit(home),
        geo_aeo.audit(home),
        ai_crawlers.audit(args.url, crawler),
        social.audit(home),
    ]
    to_console(args.url, results)
    if args.out:
        to_markdown(args.url, results, args.out)


def cmd_generate_robots(args: argparse.Namespace) -> None:
    print(robots_txt.generate(args.domain))


def cmd_generate_llms(args: argparse.Namespace) -> None:
    pages = [(t, args.domain.rstrip("/") + u, d) for t, u, d in llms_txt.DEFAULT_PAGES]
    print(llms_txt.generate(args.brand, args.summary, pages))


def cmd_generate_schema(args: argparse.Namespace) -> None:
    print("// --- LocalBusiness ---")
    print(schema.local_business(
        name=args.name, url=args.domain,
        description=args.description, phone=args.phone,
        city=args.city, region=args.region, country=args.country,
    ))
    print("\n// --- FAQPage (example — replace with your real Q&A) ---")
    print(schema.faq_page([
        ("What materials do you cast?", "We sand-cast aluminium, brass, bronze, and iron in batch and one-off runs."),
        ("What is your typical lead time?", "Most parts ship in 7-14 days depending on size, finish, and quantity."),
        ("Do you make custom patterns?", "Yes — we produce wood and resin patterns in-house from your drawings or samples."),
    ]))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="visibility_engine",
                                description="Audit & improve site + AI-search + social visibility (2026).")
    sub = p.add_subparsers(dest="command", required=True)

    a = sub.add_parser("audit", help="Crawl a site and score SEO / GEO-AEO / AI-crawler / social.")
    a.add_argument("url")
    a.add_argument("--pages", type=int, default=1, help="Max pages to crawl (default 1).")
    a.add_argument("--out", help="Write a Markdown report to this path.")
    a.set_defaults(func=cmd_audit)

    gr = sub.add_parser("generate-robots", help="Print a 2026 AI-visibility robots.txt.")
    gr.add_argument("domain")
    gr.set_defaults(func=cmd_generate_robots)

    gl = sub.add_parser("generate-llms", help="Print an llms.txt content map.")
    gl.add_argument("brand"); gl.add_argument("summary"); gl.add_argument("--domain", default="")
    gl.set_defaults(func=cmd_generate_llms)

    gs = sub.add_parser("generate-schema", help="Print LocalBusiness + FAQPage JSON-LD.")
    gs.add_argument("--name", required=True); gs.add_argument("--domain", required=True)
    gs.add_argument("--description", default="")
    gs.add_argument("--phone", default=""); gs.add_argument("--city", default="")
    gs.add_argument("--region", default=""); gs.add_argument("--country", default="TH")
    gs.set_defaults(func=cmd_generate_schema)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
