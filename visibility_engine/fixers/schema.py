"""
schema.py
---------
Generates JSON-LD blocks. LocalBusiness/Organization is the foundation for
local + knowledge-panel visibility; FAQPage is one of the strongest AEO signals
(directly cited by AI answer engines and eligible for rich results).

Drop the output into the <head> (or end of <body>) inside:
    <script type="application/ld+json"> ... </script>
"""

from __future__ import annotations

import json


def local_business(
    name: str,
    url: str,
    description: str,
    phone: str = "",
    street: str = "",
    city: str = "",
    region: str = "",
    postal: str = "",
    country: str = "TH",
    lat: float | None = None,
    lng: float | None = None,
    same_as: list[str] | None = None,
    business_type: str = "LocalBusiness",
) -> str:
    data: dict = {
        "@context": "https://schema.org",
        "@type": business_type,
        "name": name,
        "url": url,
        "description": description,
    }
    if phone:
        data["telephone"] = phone
    addr = {k: v for k, v in {
        "@type": "PostalAddress",
        "streetAddress": street,
        "addressLocality": city,
        "addressRegion": region,
        "postalCode": postal,
        "addressCountry": country,
    }.items() if v}
    if len(addr) > 1:
        data["address"] = addr
    if lat is not None and lng is not None:
        data["geo"] = {"@type": "GeoCoordinates", "latitude": lat, "longitude": lng}
    if same_as:
        data["sameAs"] = same_as
    return json.dumps(data, ensure_ascii=False, indent=2)


def faq_page(qa_pairs: list[tuple[str, str]]) -> str:
    data = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {"@type": "Answer", "text": a},
            }
            for q, a in qa_pairs
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=2)
