"""Reusable Blutenstein Visibility Engine web adapter.

This module keeps the scanner/fixer heuristics out of app.main so the same
engine can later be published as a shared package or replaced by the standalone
Marketing Visibility Engine project.

Important: all scores here are readiness heuristics. They do not claim live AI
citation/share-of-answer measurement.
"""

import html as html_lib
import ipaddress
import re
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx


def public_visibility_packages() -> list[dict]:
    return [
        {"name": "Free Visibility Starter", "price": "ฟรี", "promise": "สแกน 1 เว็บ + top 5 fixes + robots/llms/schema direction", "best_for": "เจ้าของเว็บที่อยากรู้จุดอ่อนทันที"},
        {"name": "Visibility Fix Pack", "price": "one-time", "promise": "แก้ schema, llms.txt, OG preview, FAQ, AI-answer section และ trust signals", "best_for": "เว็บที่มีบริการจริงแต่ AI/Google อ่านไม่ชัด"},
        {"name": "Growth Monitor", "price": "monthly", "promise": "สแกนรายเดือน, before/after report, content recommendations, competitor/AI-search tracking", "best_for": "SME ที่ต้องการ lead และ trust ต่อเนื่อง"},
        {"name": "Managed Blutenstein Growth", "price": "managed", "promise": "ทีม Blutenstein ดูแล visibility + content + lead capture + automation ใต้ umbrella", "best_for": "ลูกค้าที่อยากให้เราถือ end-to-end"},
    ]


def normalize_public_scan_url(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        raise ValueError("empty_url")
    if not re.match(r"^https?://", value, re.I):
        value = "https://" + value
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("invalid_url")
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or host.endswith(".local"):
        raise ValueError("blocked_host")
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("blocked_ip")
    except ValueError as exc:
        if str(exc) in {"blocked_ip"}:
            raise
    return parsed.geturl()


def has_any(text: str, terms: list[str]) -> bool:
    lower = text.lower()
    return any(t.lower() in lower for t in terms)


def extract_tag(html: str, pattern: str) -> str:
    match = re.search(pattern, html, re.I | re.S)
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()[:280]


def extract_meta_content(html: str, key_attr: str, key_value: str) -> str:
    """Return meta content regardless of attribute order.

    Many large sites vary `<meta name=... content=...>` ordering; the first
    scanner version only detected one order and produced avoidable false
    negatives.
    """
    for tag in re.findall(r"<meta\b[^>]*>", html, re.I | re.S):
        key_match = re.search(rf"\b{re.escape(key_attr)}=[\"']{re.escape(key_value)}[\"']", tag, re.I)
        if not key_match:
            continue
        content_match = re.search(r"\bcontent=[\"']([^\"']+)[\"']", tag, re.I | re.S)
        if content_match:
            return re.sub(r"\s+", " ", html_lib.unescape(content_match.group(1))).strip()[:280]
    return ""


def detect_scan_fit(url: str, html: str, text: str, title: str) -> dict:
    host = (urlparse(url).hostname or "").lower()
    lower = text.lower()
    has_search_form = bool(re.search(r"<form\b[^>]*(search|/search|q=)", html, re.I)) or bool(re.search(r"\b(search|ค้นหา)\b", lower))
    marketing_terms = ["service", "services", "pricing", "package", "case", "testimonial", "contact", "about", "บริการ", "ราคา", "แพ็กเกจ", "ผลงาน", "ติดต่อ", "เกี่ยวกับ"]
    marketing_signal_count = sum(1 for term in marketing_terms if term in lower)
    if host.endswith("google.com") or (has_search_form and marketing_signal_count <= 2 and len(text) < 2500):
        return {
            "fit": "global_utility_or_search_portal",
            "confidence": "high" if host.endswith("google.com") else "medium",
            "note": "This URL behaves like a utility/search portal, not a Thai SME service/lead-generation website. Low marketing/OG/schema scores do not mean the brand is weak; they mean this page is not built for the scanner's SME conversion/readiness checklist.",
        }
    return {
        "fit": "sme_service_or_lead_generation_page",
        "confidence": "medium",
        "note": "Scanner calibrated for SME service, local business, and lead-generation pages under the Blutenstein Growth & Trust OS.",
    }


def score_public_visibility(url: str, html: str, business_name: str | None, industry: str | None) -> dict:
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text).strip()
    title = extract_tag(html, r"<title[^>]*>(.*?)</title>")
    meta_desc = extract_meta_content(html, "name", "description")
    og_title = extract_meta_content(html, "property", "og:title")
    og_desc = extract_meta_content(html, "property", "og:description")
    og_image = extract_meta_content(html, "property", "og:image")
    scanner_fit = detect_scan_fit(url, html, text, title)
    h1_count = len(re.findall(r"<h1\b", html, re.I))
    img_count = len(re.findall(r"<img\b", html, re.I))
    img_alt_count = len(re.findall(r"<img\b[^>]*\balt=[\"'][^\"']+[\"']", html, re.I))
    categories = {
        "technical_seo": [
            ("https", "HTTPS พร้อม", url.startswith("https://"), 14),
            ("title", "มี title ชัดเจน", bool(title and (3 <= len(title) <= 80 or (business_name and business_name.lower() in title.lower()))), 14),
            ("meta_description", "มี meta description", bool(meta_desc and len(meta_desc) >= 45), 14),
            ("viewport", "รองรับ mobile viewport", "name=\"viewport\"" in html.lower() or "name='viewport'" in html.lower(), 12),
            ("h1", "มี H1 หลัก", h1_count >= 1, 10),
            ("canonical", "มี canonical URL", "rel=\"canonical\"" in html.lower() or "rel='canonical'" in html.lower(), 10),
            ("schema", "มี JSON-LD/schema", "application/ld+json" in html.lower() or "schema.org" in html.lower(), 14),
            ("image_alt", "รูปภาพมี alt text", img_count == 0 or img_alt_count / max(img_count, 1) >= 0.65, 12),
        ],
        "ai_search_readiness": [
            ("business_summary", "มี paragraph สรุปธุรกิจให้ AI เข้าใจ", len(text) >= 900 and has_any(text, ["บริการ", "service", "ลูกค้า", "customer", "สำหรับ", "we help"]), 18),
            ("question_content", "มีคำถาม/คำตอบหรือ FAQ", has_any(html, ["FAQ", "คำถาม", "ถามบ่อย", "Q&A", "How", "What", "Why"]), 16),
            ("structured_answer", "มี list/table/sections ที่อ่านง่าย", bool(re.search(r"<(ul|ol|table|section|article)\b", html, re.I)), 14),
            ("entity_signals", "มีชื่อธุรกิจ/อุตสาหกรรมซ้ำชัด", bool((business_name and business_name.lower() in text.lower()) or (industry and industry.lower() in text.lower())), 14),
            ("freshness", "มีสัญญาณความสดใหม่", bool(re.search(r"20[2-9][0-9]|updated|ล่าสุด|ใหม่", text, re.I)), 10),
            ("citation_ready", "มีลิงก์/หลักฐาน/หน้าอ้างอิง", len(re.findall(r"<a\b", html, re.I)) >= 4, 12),
            ("llms_or_ai", "มี llms.txt/AI-readable mention", "llms.txt" in html.lower() or "ai search" in html.lower() or "ai visibility" in html.lower(), 16),
        ],
        "social_preview": [
            ("og_title", "มี og:title", bool(og_title), 22),
            ("og_description", "มี og:description", bool(og_desc), 22),
            ("og_image", "มี og:image สำหรับแชร์", bool(og_image), 24),
            ("twitter_card", "มี Twitter/X card", "twitter:card" in html.lower(), 16),
            ("share_copy", "copy สำหรับ social อ่านรู้เรื่อง", bool(title and meta_desc), 16),
        ],
        "trust_signals": [
            ("contact", "มีช่องทางติดต่อ", has_any(text, ["โทร", "phone", "email", "line", "ติดต่อ", "contact"]), 20),
            ("about", "มี about/company trust context", has_any(text, ["about", "เกี่ยวกับ", "company", "บริษัท", "ทีม"]), 16),
            ("services", "บริการ/ข้อเสนอชัดเจน", has_any(text, ["บริการ", "services", "package", "แพ็กเกจ", "ราคา", "pricing"]), 18),
            ("proof", "มี proof/case/client/testimonial", has_any(text, ["case", "ลูกค้า", "ผลงาน", "testimonial", "review", "trusted", "verified"]), 16),
            ("policy", "มี privacy/terms/safety signal", has_any(text, ["privacy", "terms", "นโยบาย", "ปลอดภัย", "secure"]), 10),
            ("local_entity", "มี local/entity signal", has_any(text, ["Thailand", "ไทย", "Bangkok", "กรุงเทพ", "บริษัท", "address", "ที่อยู่"]), 20),
        ],
    }
    scored = {}
    all_fixes = []
    for key, checks in categories.items():
        max_score = sum(w for *_rest, w in checks)
        got = sum(w for _, _, ok, w in checks if ok)
        items = [{"key": k, "label": label, "ok": ok, "weight": w} for k, label, ok, w in checks]
        scored[key] = {"score": round(got * 100 / max_score), "checks": items}
        for k, label, ok, w in checks:
            if not ok:
                all_fixes.append({"category": key, "key": k, "title": label, "impact": w})
    overall = round(scored["technical_seo"]["score"] * .30 + scored["ai_search_readiness"]["score"] * .30 + scored["social_preview"]["score"] * .20 + scored["trust_signals"]["score"] * .20)
    grade = "A" if overall >= 85 else "B" if overall >= 70 else "C" if overall >= 55 else "D"
    top_fixes = sorted(all_fixes, key=lambda x: x["impact"], reverse=True)[:5]
    return {
        "url": url,
        "title": title,
        "meta_description": meta_desc,
        "overall_score": overall,
        "grade": grade,
        "categories": scored,
        "top_fixes": top_fixes,
        "positioning_note": "Current scan is an evidence-based readiness heuristic. Real AI citation/share-of-answer tracking is the next paid monitoring layer.",
        "scanner_fit": scanner_fit,
        "packages": public_visibility_packages(),
    }


async def fetch_homepage_html(url: str) -> tuple[str, int, str]:
    async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers={"User-Agent": "BlutensteinVisibilityScanner/1.0 (+https://www.blutenstein.com/)"}) as client:
        resp = await client.get(url)
        content_type = resp.headers.get("content-type", "")
        if "text/html" not in content_type and resp.text and "<html" not in resp.text[:1000].lower():
            raise ValueError("not_html")
        return resp.text[:900_000], resp.status_code, str(resp.url)


async def fetch_public_text(url: str, timeout: int = 8) -> tuple[int | None, str]:
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers={"User-Agent": "BlutensteinVisibilityScanner/1.0 (+https://www.blutenstein.com/)"}) as client:
            resp = await client.get(url)
            return resp.status_code, resp.text[:250_000]
    except Exception:
        return None, ""


def discover_public_scan_pages(base_url: str, homepage_html: str, max_pages: int = 4) -> list[str]:
    parsed = urlparse(base_url)
    host = parsed.netloc
    out: list[str] = []
    seen = {base_url.rstrip("/")}
    for href in re.findall(r"<a\b[^>]+href=[\"']([^\"'#]+)[\"']", homepage_html, re.I):
        full = html_lib.unescape(urljoin(base_url, href).split("#")[0]).rstrip("/")
        pp = urlparse(full)
        if pp.scheme not in {"http", "https"} or pp.netloc != host:
            continue
        if any(skip in pp.path.lower() for skip in ["/admin", "/login", "/cart", "/checkout", "/wp-json"]):
            continue
        if full not in seen:
            seen.add(full)
            out.append(full)
        if len(out) >= max_pages - 1:
            break
    return out


async def enrich_visibility_engine_scan(final_url: str, homepage_html: str, homepage_result: dict, payload: Any) -> dict:
    """Web/API version of the standalone Visibility Engine: homepage + light site crawl + robots/llms/sitemap evidence.

    This remains a readiness audit, not a claim of real AI citation tracking. Real share-of-answer monitoring belongs in the paid Growth Monitor layer.
    """
    root = f"{urlparse(final_url).scheme}://{urlparse(final_url).netloc}"
    page_urls = discover_public_scan_pages(final_url, homepage_html, max_pages=4)
    page_rollup = [{
        "url": final_url,
        "score": homepage_result["overall_score"],
        "technical_score": homepage_result["categories"]["technical_seo"]["score"],
        "ai_score": homepage_result["categories"]["ai_search_readiness"]["score"],
        "social_score": homepage_result["categories"]["social_preview"]["score"],
        "trust_score": homepage_result["categories"]["trust_signals"]["score"],
        "title": homepage_result.get("title", ""),
        "http_status": None,
    }]
    for page_url in page_urls:
        try:
            html, status_code, fetched_url = await fetch_homepage_html(page_url)
            page_score = score_public_visibility(fetched_url, html, payload.business_name, payload.industry)
            page_rollup.append({
                "url": fetched_url,
                "score": page_score["overall_score"],
                "technical_score": page_score["categories"]["technical_seo"]["score"],
                "ai_score": page_score["categories"]["ai_search_readiness"]["score"],
                "social_score": page_score["categories"]["social_preview"]["score"],
                "trust_score": page_score["categories"]["trust_signals"]["score"],
                "title": page_score.get("title", ""),
                "http_status": status_code,
            })
        except Exception:
            continue

    robots_status, robots_text = await fetch_public_text(f"{root}/robots.txt")
    llms_status, llms_text = await fetch_public_text(f"{root}/llms.txt")
    sitemap_status, sitemap_text = await fetch_public_text(f"{root}/sitemap.xml")
    ai_bots = ["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Claude-SearchBot", "Google-Extended"]
    blocked_bots = []
    robots_lower = robots_text.lower()
    for bot in ai_bots:
        pattern = rf"user-agent:\s*({re.escape(bot.lower())}|\*)[\s\S]{{0,240}}?disallow:\s*/(?:\s|$)"
        if robots_status == 200 and re.search(pattern, robots_lower, re.I):
            blocked_bots.append(bot)
    sitemap_lower = sitemap_text[:4000].lower()
    sitemap_present = sitemap_status == 200 and any(marker in sitemap_lower for marker in ["<urlset", "<sitemapindex", "<url", "<sitemap"])
    crawler_checks = [
        ("robots_txt", "robots.txt present", robots_status == 200, 22),
        ("sitemap_xml", "sitemap.xml or sitemap index present", sitemap_present, 22),
        ("llms_txt", "llms.txt present", llms_status == 200 and len(llms_text.strip()) > 80, 18),
        ("ai_bots", "major AI visibility bots not explicitly blocked", not blocked_bots, 26),
        ("multi_page", "scan sampled more than homepage", len(page_rollup) > 1, 12),
    ]
    max_score = sum(w for *_rest, w in crawler_checks)
    got = sum(w for _, _, ok, w in crawler_checks if ok)
    crawler_score = round(got * 100 / max_score)
    homepage_result["categories"]["ai_crawler_access"] = {
        "score": crawler_score,
        "checks": [{"key": k, "label": label, "ok": ok, "weight": w} for k, label, ok, w in crawler_checks],
    }
    for k, label, ok, w in crawler_checks:
        if not ok:
            homepage_result["top_fixes"].append({"category": "ai_crawler_access", "key": k, "title": label, "impact": w})
    page_avg = round(sum(p["score"] for p in page_rollup) / len(page_rollup)) if page_rollup else homepage_result["overall_score"]
    homepage_result["overall_score"] = round(homepage_result["overall_score"] * 0.72 + page_avg * 0.18 + crawler_score * 0.10)
    homepage_result["grade"] = "A" if homepage_result["overall_score"] >= 85 else "B" if homepage_result["overall_score"] >= 70 else "C" if homepage_result["overall_score"] >= 55 else "D"
    homepage_result["top_fixes"] = sorted(homepage_result["top_fixes"], key=lambda x: x["impact"], reverse=True)[:7]
    if not homepage_result["top_fixes"]:
        homepage_result["top_fixes"] = [{"category": "growth_monitor", "key": "monitoring", "title": "No critical gaps detected — next paid value is Growth Monitor: competitor checks, AI citation/share-of-answer tracking, freshness and conversion proof.", "impact": 1}]
    homepage_result["engine_mode"] = "full_web_api_light_crawl"
    homepage_result["scan_depth"] = {"pages_checked": len(page_rollup), "max_pages": 4, "discovery": "homepage_internal_links_plus_site_resources"}
    homepage_result["page_rollup"] = page_rollup
    homepage_result["crawler_evidence"] = {
        "robots_status": robots_status,
        "sitemap_status": sitemap_status,
        "sitemap_detected": sitemap_present,
        "llms_status": llms_status,
        "blocked_ai_bots": blocked_bots,
        "claims_guardrail": "Readiness heuristic only; not live AI citation/share-of-answer measurement.",
    }
    homepage_result["positioning_note"] = "Full web/API readiness scan: homepage + light internal crawl + robots/sitemap/llms/AI-crawler checks. This is still a readiness heuristic; real AI citation/share-of-answer tracking is the paid Growth Monitor layer."
    return homepage_result


