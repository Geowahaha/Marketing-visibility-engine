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
            # Fix mojibake (esp. Thai): when the server omits a charset, requests
            # defaults to ISO-8859-1. Prefer the encoding sniffed from content.
            if not resp.encoding or resp.encoding.lower() in ("iso-8859-1", "latin-1"):
                resp.encoding = resp.apparent_encoding or "utf-8"
            try:
                soup = BeautifulSoup(resp.text, "lxml")
            except Exception:
                soup = BeautifulSoup(resp.text, "html.parser")
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
        """Fetch a raw text resource (robots.txt, llms.txt, sitemap).

        Transparently gunzips .gz sitemaps so sitemap_urls() works on both.
        """
        try:
            resp = self.session.get(url, timeout=self.timeout, allow_redirects=True)
            body = resp.text
            if url.lower().endswith(".gz") or "application/x-gzip" in \
                    resp.headers.get("Content-Type", ""):
                import gzip
                try:
                    body = gzip.decompress(resp.content).decode("utf-8", "replace")
                except OSError:
                    body = resp.text
            return resp.status_code, body
        except requests.RequestException:
            return None, ""

    def sitemap_urls(self, base_url: str, cap: int = 50) -> list[str]:
        """Discover URLs from the site's sitemap(s).

        Resolution order:
          1. every `Sitemap:` line declared in robots.txt
          2. fall back to <root>/sitemap.xml and <root>/sitemap_index.xml
        Handles sitemap *index* files (recurses one level into child sitemaps)
        and namespaced XML. Returns deduped same-host URLs, capped.
        """
        import re
        import xml.etree.ElementTree as ET
        from urllib.parse import urlparse as _up

        root = f"{_up(base_url).scheme or 'https'}://{_up(base_url).netloc or base_url}"
        host = _up(root).netloc

        # 1) collect candidate sitemap locations from robots.txt
        candidates: list[str] = []
        status, robots = self.fetch_text(f"{root}/robots.txt")
        if status == 200 and robots:
            for line in robots.splitlines():
                if line.lower().strip().startswith("sitemap:"):
                    candidates.append(line.split(":", 1)[1].strip())
        candidates += [f"{root}/sitemap.xml", f"{root}/sitemap_index.xml"]

        def _locs(xml_text: str) -> tuple[list[str], list[str]]:
            """Return (page_urls, child_sitemap_urls) from a sitemap document."""
            pages, children = [], []
            try:
                rootel = ET.fromstring(xml_text.encode("utf-8", "replace"))
            except ET.ParseError:
                # tolerate stray bytes/BOM
                txt = re.sub(r"^[^<]*", "", xml_text)
                try:
                    rootel = ET.fromstring(txt.encode("utf-8", "replace"))
                except ET.ParseError:
                    return pages, children
            tag = rootel.tag.split("}")[-1].lower()
            for loc in rootel.iter():
                if loc.tag.split("}")[-1].lower() == "loc" and loc.text:
                    (children if tag == "sitemapindex" else pages).append(loc.text.strip())
            return pages, children

        found: list[str] = []
        seen_sitemaps: set[str] = set()
        for cand in candidates:
            if cand in seen_sitemaps:
                continue
            seen_sitemaps.add(cand)
            st, body = self.fetch_text(cand)
            if st != 200 or not body.strip().startswith("<"):
                continue
            pages, children = _locs(body)
            found += pages
            # recurse one level into child sitemaps from an index
            for child in children[:10]:
                if child in seen_sitemaps:
                    continue
                seen_sitemaps.add(child)
                cst, cbody = self.fetch_text(child)
                if cst == 200 and cbody.strip().startswith("<"):
                    cpages, _ = _locs(cbody)
                    found += cpages
            if found:
                break  # first sitemap that yields URLs wins

        out, seen = [], set()
        for u in found:
            u = u.split("#")[0].rstrip("/")
            if u and _up(u).netloc == host and u not in seen:
                seen.add(u)
                out.append(u)
            if len(out) >= cap:
                break
        return out

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

    def crawl(self, base_url: str, max_pages: int = 1,
              use_sitemap: bool = False) -> list[FetchResult]:
        results = [self.fetch(base_url)]
        if max_pages <= 1 or not results[0].ok:
            return results

        queue: list[str] = []
        if use_sitemap:
            def _norm(u: str) -> str:
                u = u.rstrip("/")
                for ix in ("/index.html", "/index.htm", "/index.php"):
                    if u.endswith(ix):
                        u = u[: -len(ix)]
                return u or u
            home = _norm(results[0].url)
            seen_norm = {home}
            for u in self.sitemap_urls(base_url, cap=max_pages * 3):
                n = _norm(u)
                if n in seen_norm:
                    continue
                seen_norm.add(n)
                queue.append(u)
        if not queue:  # no sitemap (or none requested) -> fall back to <a> links
            queue = self.internal_links(results[0], base_url, limit=max_pages - 1)

        for link in queue[: max_pages - 1]:
            time.sleep(self.delay)
            results.append(self.fetch(link))
        return results
