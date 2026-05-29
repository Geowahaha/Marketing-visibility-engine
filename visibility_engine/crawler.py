"""
crawler.py
----------
Lightweight crawler. Fetches a page (and optionally same-domain internal links
up to a depth), measures response timing, and hands back parsed soup objects.

Network calls are deliberately polite: a real desktop user-agent, a timeout,
and a small inter-request delay so you never hammer a small business host.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 VisibilityEngine/1.0"
)


@dataclass
class FetchResult:
    url: str
    status: int | None = None
    ok: bool = False
    elapsed_ms: int = 0
    html: str = ""
    headers: dict = field(default_factory=dict)
    error: str | None = None
    soup: BeautifulSoup | None = None


class Crawler:
    def __init__(self, user_agent: str = DEFAULT_UA, timeout: int = 20, delay: float = 0.7):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self.timeout = timeout
        self.delay = delay

    def fetch(self, url: str) -> FetchResult:
        try:
            start = time.perf_counter()
            resp = self.session.get(url, timeout=self.timeout, allow_redirects=True)
            elapsed = int((time.perf_counter() - start) * 1000)
            soup = BeautifulSoup(resp.text, "lxml")
            return FetchResult(
                url=resp.url,
                status=resp.status_code,
                ok=resp.ok,
                elapsed_ms=elapsed,
                html=resp.text,
                headers=dict(resp.headers),
                soup=soup,
            )
        except requests.RequestException as exc:
            return FetchResult(url=url, error=str(exc))

    def fetch_text(self, url: str) -> tuple[int | None, str]:
        """Fetch a raw text resource (robots.txt, llms.txt, sitemap)."""
        try:
            resp = self.session.get(url, timeout=self.timeout, allow_redirects=True)
            return resp.status_code, resp.text
        except requests.RequestException:
            return None, ""

    def internal_links(self, result: FetchResult, base_url: str, limit: int = 25) -> list[str]:
        if not result.soup:
            return []
        host = urlparse(base_url).netloc
        seen, out = set(), []
        for a in result.soup.find_all("a", href=True):
            full = urljoin(base_url, a["href"]).split("#")[0].rstrip("/")
            if not full:
                continue
            if urlparse(full).netloc == host and full not in seen:
                seen.add(full)
                out.append(full)
            if len(out) >= limit:
                break
        return out

    def crawl(self, base_url: str, max_pages: int = 1) -> list[FetchResult]:
        results = [self.fetch(base_url)]
        if max_pages <= 1 or not results[0].ok:
            return results
        queue = self.internal_links(results[0], base_url, limit=max_pages - 1)
        for link in queue[: max_pages - 1]:
            time.sleep(self.delay)
            results.append(self.fetch(link))
        return results
