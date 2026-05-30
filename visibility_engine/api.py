from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .web_adapter import (
    enrich_visibility_engine_scan,
    fetch_homepage_html,
    normalize_public_scan_url,
    score_public_visibility,
)

APP_VERSION = os.getenv("APP_VERSION", "0.3.0")
BUILD_SHA = os.getenv("BUILD_SHA", "dev")
BUILD_TIME = os.getenv("BUILD_TIME", "unknown")
DATA_DIR = Path(os.getenv("VISIBILITY_ENGINE_DATA_DIR", "/data"))
DB_PATH = Path(os.getenv("VISIBILITY_ENGINE_DB", str(DATA_DIR / "visibility_engine.sqlite3")))

app = FastAPI(title="Marketing Visibility Engine API", version=APP_VERSION)


class PublicVisibilityScan(BaseModel):
    url: str = Field(min_length=4, max_length=260)
    business_name: Optional[str] = Field(default=None, max_length=160)
    industry: Optional[str] = Field(default=None, max_length=160)
    email: Optional[str] = Field(default=None, max_length=180)
    line_id: Optional[str] = Field(default=None, max_length=120)
    phone: Optional[str] = Field(default=None, max_length=80)


class GrowthMonitorSubscription(BaseModel):
    url: str = Field(min_length=4, max_length=260)
    business_name: Optional[str] = Field(default=None, max_length=160)
    industry: Optional[str] = Field(default=None, max_length=160)
    email: Optional[str] = Field(default=None, max_length=180)
    line_id: Optional[str] = Field(default=None, max_length=120)
    phone: Optional[str] = Field(default=None, max_length=80)
    cadence: str = Field(default="monthly", pattern="^(weekly|monthly)$")
    competitors: list[str] = Field(default_factory=list, max_length=5)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_email(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().lower() or None


def normalize_phone(value: str | None) -> str | None:
    if not value:
        return None
    raw = re.sub(r"[^0-9+]", "", value.strip())
    if raw.startswith("+66"):
        return "0" + raw[3:]
    if raw.startswith("66") and len(raw) >= 11:
        return "0" + raw[2:]
    return raw or None


def normalize_handle(value: str | None) -> str | None:
    if not value:
        return None
    return value.strip().lstrip("@").replace(" ", "") or None


def db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS scans (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              url TEXT NOT NULL,
              score INTEGER NOT NULL,
              status TEXT NOT NULL,
              summary_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scan_pages (
              id TEXT PRIMARY KEY,
              scan_id TEXT NOT NULL,
              url TEXT NOT NULL,
              score INTEGER,
              technical_score INTEGER,
              ai_score INTEGER,
              social_score INTEGER,
              trust_score INTEGER,
              http_status INTEGER,
              title TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS leads (
              id TEXT PRIMARY KEY,
              scan_id TEXT NOT NULL,
              tenant_slug TEXT NOT NULL,
              url TEXT NOT NULL,
              business_name TEXT,
              industry TEXT,
              email TEXT,
              phone TEXT,
              line_id TEXT,
              status TEXT DEFAULT 'new',
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS monitor_subscriptions (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              url TEXT NOT NULL,
              business_name TEXT,
              industry TEXT,
              email TEXT,
              phone TEXT,
              line_id TEXT,
              cadence TEXT NOT NULL,
              competitors_json TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              last_scan_id TEXT,
              next_run_at TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS monitor_runs (
              id TEXT PRIMARY KEY,
              subscription_id TEXT NOT NULL,
              scan_id TEXT NOT NULL,
              baseline_score INTEGER,
              latest_score INTEGER NOT NULL,
              delta_score INTEGER NOT NULL,
              competitor_summary_json TEXT NOT NULL,
              ai_visibility_note TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at);
            CREATE INDEX IF NOT EXISTS idx_scan_pages_scan ON scan_pages(scan_id);
            CREATE INDEX IF NOT EXISTS idx_monitor_next ON monitor_subscriptions(status,next_run_at);
            CREATE INDEX IF NOT EXISTS idx_monitor_runs_subscription ON monitor_runs(subscription_id,created_at);
            """
        )


@app.on_event("startup")
def _startup() -> None:
    init_db()


def tenant_slug_from_url(url: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", (urlparse(url).hostname or "custom").lower()).strip("-")[:80] or "custom"


def next_run(cadence: str, from_time: datetime | None = None) -> str:
    base = from_time or datetime.now(timezone.utc)
    return (base + timedelta(days=7 if cadence == "weekly" else 30)).isoformat()


def claim_note() -> str:
    return (
        "Growth Monitor tracks readiness deltas, competitor baselines, and public prompt/check evidence. "
        "It does not claim exact AI citation/share-of-answer until a verified provider/search-result evidence layer is connected."
    )


@app.get("/healthz")
def healthz():
    init_db()
    return {"status": "ok", "service": "visibility-engine-api", "version": APP_VERSION, "build_sha": BUILD_SHA}


@app.get("/version")
def version():
    return {
        "status": "ok",
        "service": "visibility-engine-api",
        "version": APP_VERSION,
        "build_sha": BUILD_SHA,
        "build_time": BUILD_TIME,
        "verification_marker": f"visibility-engine-api:{APP_VERSION}:{BUILD_SHA}",
    }


@app.get("/status")
def status():
    init_db()
    with db() as conn:
        scans = conn.execute("SELECT COUNT(*) AS n FROM scans").fetchone()["n"]
        leads = conn.execute("SELECT COUNT(*) AS n FROM leads").fetchone()["n"]
        subs = conn.execute("SELECT COUNT(*) AS n FROM monitor_subscriptions WHERE status='active'").fetchone()["n"]
        runs = conn.execute("SELECT COUNT(*) AS n FROM monitor_runs").fetchone()["n"]
    return {
        "status": "ready",
        "service": "Marketing Visibility Engine API",
        "version": APP_VERSION,
        "build_sha": BUILD_SHA,
        "storage": "sqlite",
        "counts": {"scans": scans, "leads": leads, "active_subscriptions": subs, "monitor_runs": runs},
        "claims_guardrail": "Readiness heuristic only; real AI citation/share-of-answer needs verified evidence providers.",
    }


@app.post("/scan")
async def scan(payload: PublicVisibilityScan):
    try:
        url = normalize_public_scan_url(payload.url)
        html, status_code, final_url = await fetch_homepage_html(url)
        result = score_public_visibility(final_url, html, payload.business_name, payload.industry)
        result = await enrich_visibility_engine_scan(final_url, html, result, payload)
    except Exception as exc:
        return {"status": "error", "message": "scan_failed", "detail": str(exc)[:160]}

    init_db()
    scan_id = "scan_" + uuid.uuid4().hex[:12]
    tenant_slug = tenant_slug_from_url(final_url)
    result.update({
        "scan_id": scan_id,
        "http_status": status_code,
        "business_name": payload.business_name,
        "industry": payload.industry,
        "created_at": now_iso(),
        "engine_owner": "visibility-engine-api",
    })
    lead_id = "vlead_" + hashlib.sha1((scan_id + final_url + (payload.email or payload.phone or payload.line_id or "")).encode()).hexdigest()[:16]
    with db() as conn:
        conn.execute(
            "INSERT INTO scans(id,tenant_slug,url,score,status,summary_json,created_at) VALUES(?,?,?,?,?,?,?)",
            (scan_id, tenant_slug, final_url, result["overall_score"], "completed", json.dumps(result, ensure_ascii=False), now_iso()),
        )
        for page in result.get("page_rollup", []):
            conn.execute(
                """INSERT INTO scan_pages(id,scan_id,url,score,technical_score,ai_score,social_score,trust_score,http_status,title,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                ("vpage_" + uuid.uuid4().hex[:12], scan_id, page.get("url", ""), int(page.get("score", 0)), int(page.get("technical_score", 0)), int(page.get("ai_score", 0)), int(page.get("social_score", 0)), int(page.get("trust_score", 0)), page.get("http_status"), page.get("title", ""), now_iso()),
            )
        conn.execute(
            """INSERT INTO leads(id,scan_id,tenant_slug,url,business_name,industry,email,phone,line_id,status,payload_json,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (lead_id, scan_id, tenant_slug, final_url, payload.business_name, payload.industry, normalize_email(payload.email), normalize_phone(payload.phone), normalize_handle(payload.line_id), "new", json.dumps({"score": result["overall_score"], "grade": result["grade"], "engine_mode": result.get("engine_mode")}, ensure_ascii=False), now_iso()),
        )
    result["lead_id"] = lead_id
    return {"status": "ok", "scan": result, "lead_id": lead_id, "report_url": f"/report/{scan_id}"}


async def run_subscription(row: sqlite3.Row) -> dict:
    competitors = json.loads(row["competitors_json"] or "[]")[:5]
    owner = await scan(PublicVisibilityScan(
        url=row["url"], business_name=row["business_name"], industry=row["industry"],
        email=row["email"], line_id=row["line_id"], phone=row["phone"]
    ))
    if owner.get("status") != "ok":
        return {"status": "error", "subscription_id": row["id"], "detail": owner.get("detail") or owner.get("message")}
    scan_data = owner["scan"]
    competitor_results = []
    for url in competitors:
        competitor = await scan(PublicVisibilityScan(url=url, industry=row["industry"]))
        if competitor.get("status") == "ok":
            competitor_results.append({
                "url": competitor["scan"].get("url"),
                "score": competitor["scan"].get("overall_score"),
                "grade": competitor["scan"].get("grade"),
                "engine_mode": competitor["scan"].get("engine_mode"),
            })
        else:
            competitor_results.append({"url": url, "status": "scan_failed"})
    with db() as conn:
        previous = conn.execute("SELECT latest_score FROM monitor_runs WHERE subscription_id=? ORDER BY created_at DESC LIMIT 1", (row["id"],)).fetchone()
        baseline = previous["latest_score"] if previous else None
        latest = int(scan_data["overall_score"])
        delta = latest - baseline if baseline is not None else 0
        run_id = "gmon_" + uuid.uuid4().hex[:12]
        conn.execute(
            """INSERT INTO monitor_runs(id,subscription_id,scan_id,baseline_score,latest_score,delta_score,competitor_summary_json,ai_visibility_note,created_at)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (run_id, row["id"], scan_data["scan_id"], baseline, latest, delta, json.dumps({"competitors": competitor_results}, ensure_ascii=False), claim_note(), now_iso()),
        )
        conn.execute("UPDATE monitor_subscriptions SET last_scan_id=?, next_run_at=? WHERE id=?", (scan_data["scan_id"], next_run(row["cadence"]), row["id"]))
    return {"status": "ok", "run_id": run_id, "subscription_id": row["id"], "scan_id": scan_data["scan_id"], "score": latest, "delta_score": delta, "competitors_checked": len(competitor_results), "report_url": f"/report/{scan_data['scan_id']}", "claims_guardrail": claim_note()}


@app.post("/growth-monitor/subscribe")
async def subscribe(payload: GrowthMonitorSubscription):
    try:
        url = normalize_public_scan_url(payload.url)
        competitors = [normalize_public_scan_url(c) for c in payload.competitors[:5] if c.strip()]
    except Exception as exc:
        return {"status": "error", "message": "invalid_monitor_url", "detail": str(exc)[:160]}
    init_db()
    tenant_slug = tenant_slug_from_url(url)
    subscription_id = "vmon_" + hashlib.sha1((url + payload.cadence + "|".join(competitors)).encode()).hexdigest()[:16]
    with db() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO monitor_subscriptions(id,tenant_slug,url,business_name,industry,email,phone,line_id,cadence,competitors_json,status,last_scan_id,next_run_at,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM monitor_subscriptions WHERE id=?),?))""",
            (subscription_id, tenant_slug, url, payload.business_name, payload.industry, normalize_email(payload.email), normalize_phone(payload.phone), normalize_handle(payload.line_id), payload.cadence, json.dumps(competitors, ensure_ascii=False), "active", None, now_iso(), subscription_id, now_iso()),
        )
        row = conn.execute("SELECT * FROM monitor_subscriptions WHERE id=?", (subscription_id,)).fetchone()
    first_run = await run_subscription(row)
    return {"status": "ok", "subscription_id": subscription_id, "cadence": payload.cadence, "next_run_at": next_run(payload.cadence), "competitors": competitors, "first_run": first_run, "offer": "Growth Monitor monthly: scheduled rescans, competitor baseline, before/after proof, and careful AI visibility evidence without overclaiming citation tracking."}


@app.get("/growth-monitor/status")
def monitor_status():
    init_db()
    with db() as conn:
        subs = conn.execute("SELECT COUNT(*) AS n FROM monitor_subscriptions WHERE status='active'").fetchone()["n"]
        runs = conn.execute("SELECT COUNT(*) AS n FROM monitor_runs").fetchone()["n"]
        due = conn.execute("SELECT COUNT(*) AS n FROM monitor_subscriptions WHERE status='active' AND next_run_at<=?", (now_iso(),)).fetchone()["n"]
        latest = conn.execute("""SELECT r.id,r.subscription_id,r.scan_id,r.latest_score,r.delta_score,r.created_at,s.url
                                FROM monitor_runs r JOIN monitor_subscriptions s ON s.id=r.subscription_id
                                ORDER BY r.created_at DESC LIMIT 5""").fetchall()
    return {"status": "ready", "product": "Blutenstein Growth Monitor", "service": "visibility-engine-api", "active_subscriptions": subs, "monitor_runs": runs, "due_now": due, "cadences": ["weekly", "monthly"], "latest_runs": [dict(row) for row in latest], "claims_guardrail": claim_note(), "scheduler_note": "Call POST /growth-monitor/run-due from cron/Hermes/Cloud scheduler."}


@app.post("/growth-monitor/run-due")
async def run_due(limit: int = 5):
    init_db()
    with db() as conn:
        rows = conn.execute("SELECT * FROM monitor_subscriptions WHERE status='active' AND next_run_at<=? ORDER BY next_run_at ASC LIMIT ?", (now_iso(), max(1, min(limit, 10)))).fetchall()
    results = []
    for row in rows:
        results.append(await run_subscription(row))
    return {"status": "ok", "runs_attempted": len(results), "results": results, "claims_guardrail": claim_note()}


def render_report(data: dict) -> str:
    fixes = "".join(f"<li><b>{f['title']}</b><br><span>{f['category']} · impact {f['impact']}</span></li>" for f in data.get("top_fixes", [])) or "<li><b>No critical gaps detected</b><br><span>Use Growth Monitor to track competitors, AI citations, freshness, and conversion proof over time.</span></li>"
    cats = "".join(f"<div class='card'><span class='num'>{k}</span><h3>{v['score']}/100</h3><p>{sum(1 for c in v['checks'] if c['ok'])}/{len(v['checks'])} checks passed</p></div>" for k, v in data.get("categories", {}).items())
    packages = "".join(f"<div class='card'><span class='num'>{p['price']}</span><h3>{p['name']}</h3><p>{p['promise']}</p><small>{p['best_for']}</small></div>" for p in data.get("packages", []))
    pages = "".join(f"<li><b>{p.get('score')}/100</b> — {p.get('url','')}<br><span>SEO {p.get('technical_score')} · AI {p.get('ai_score')} · Social {p.get('social_score')} · Trust {p.get('trust_score')}</span></li>" for p in data.get("page_rollup", []))
    ev = data.get("crawler_evidence", {})
    evidence = f"robots {ev.get('robots_status')} · sitemap {ev.get('sitemap_status')} ({'detected' if ev.get('sitemap_detected') else 'not detected'}) · llms {ev.get('llms_status')} · blocked bots {', '.join(ev.get('blocked_ai_bots') or []) or 'none detected'}"
    fit = data.get("scanner_fit", {})
    fit_note = f"<p><b>Scanner fit:</b> {fit.get('fit','unknown')} · {fit.get('note','')}</p>" if fit else ""
    return f"""<!doctype html><html lang='th'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Visibility Report</title><style>body{{margin:0;background:#f6f9fc;color:#061b31;font-family:Inter,system-ui,sans-serif}}.wrap{{max-width:1080px;margin:auto;padding:34px 22px}}.hero,.card{{background:white;border:1px solid #e5edf5;border-radius:18px;padding:24px;box-shadow:rgba(23,23,23,.07) 0 14px 34px}}h1{{font-size:clamp(42px,7vw,76px);letter-spacing:-.06em;line-height:1;margin:10px 0}}.score{{font-size:72px;color:#533afd;letter-spacing:-.07em}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:18px}}.num{{font:12px monospace;color:#533afd;background:#f1f0ff;padding:5px 7px;border-radius:5px}}li{{margin:12px 0;color:#475569}}.btn{{display:inline-block;background:#533afd;color:white;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700}}</style></head><body><main class='wrap'><section class='hero'><a href='https://www.blutenstein.com/' class='btn'>← Blutenstein</a><h1>Visibility Report</h1><p>{data.get('url','')}</p><div class='score'>{data.get('overall_score')}/100 · Grade {data.get('grade')}</div><p>{data.get('positioning_note','')}</p>{fit_note}<p><b>Engine:</b> {data.get('engine_mode','heuristic')} · {evidence}</p></section><section class='grid'>{cats}</section><section class='hero' style='margin-top:18px'><h2>Pages checked</h2><ol>{pages}</ol></section><section class='hero' style='margin-top:18px'><h2>Top fixes</h2><ol>{fixes}</ol><a class='btn' href='https://www.blutenstein.com/#demo'>ให้ Blutenstein ช่วยแก้ให้</a></section><section class='grid'>{packages}</section></main></body></html>"""


@app.get("/report/{scan_id}", response_class=HTMLResponse)
def report(scan_id: str):
    init_db()
    with db() as conn:
        row = conn.execute("SELECT * FROM scans WHERE id=?", (scan_id,)).fetchone()
    if not row:
        return HTMLResponse("<h1>Visibility report not found</h1>", status_code=404)
    return HTMLResponse(render_report(json.loads(row["summary_json"])))
