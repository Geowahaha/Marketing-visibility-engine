/**
 * Cloudflare Pages Function — /api/proof  (per-account before/after proof)
 * ------------------------------------------------------------------
 * The retention + trust engine: prove the score actually moved after fixes.
 *
 *   POST /api/proof  { url, account?, email? }
 *        → runs a fresh /api/scan, loads the stored baseline for this
 *          account+site, computes overall + per-category deltas, stores the
 *          new scan as "latest" (and as baseline on first ever run).
 *
 *   GET  /api/proof?url=...&account=...
 *        → returns the stored baseline + latest without re-scanning.
 *
 * KV binding: PROOF_KV (required to persist history; without it, POST still
 * returns a one-off scan but can't show before/after).
 *
 * Env: SITE_ORIGIN (optional, for internal scan call).
 */

import { agentKv } from "./_agent.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}
function bareHost(u) { try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } }
function originOf(request, env) {
  if (env.SITE_ORIGIN) return String(env.SITE_ORIGIN).replace(/\/+$/, "");
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}
function accountOf(payload, request) {
  const fromBody = (payload?.account || payload?.email || "").toString().trim().toLowerCase();
  if (fromBody) return fromBody.replace(/[^a-z0-9@._-]+/g, "");
  return "anon";
}
function kvKey(account, host) { return `proof:${account}:${host}`; }
function shareKey(id) { return `proof-share:${id}`; }
function proofStore(env) {
  if (env.AGENT_DB) return agentKv(env);
  return env.PROOF_KV || null;
}

function scoreDelta(before, after) {
  if (before == null || after == null) return null;
  return Math.round(Number(after) - Number(before));
}

function safeList(arr, limit = 8) {
  return Array.isArray(arr) ? arr.filter(Boolean).slice(0, limit) : [];
}

function statusOf(x) {
  return String(x?.status || (x?.ok ? "pass" : "fail")).toLowerCase();
}

function findingKey(f) {
  return `${String(f.category || "").toLowerCase()}::${String(f.check || "").toLowerCase()}`;
}

async function shortHash(input) {
  const text = String(input || "");
  if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 12);
}

async function proofShareId(account, host) {
  const slug = String(host || "site").replace(/^www\./i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 48) || "site";
  return `${slug}-${await shortHash(`${account}|${host}`)}`;
}

function proofLinks(url, facts = {}) {
  let root = "";
  try { root = new URL(url).origin; } catch { root = ""; }
  const f = facts.fetch || {};
  const links = [{ label: "Scanned page", url, status: f.home?.ok ? "verified" : "checked" }];
  if (root && f.robots?.present) links.push({ label: "robots.txt", url: `${root}/robots.txt`, status: "verified" });
  if (root && f.sitemap?.present) links.push({ label: "sitemap.xml", url: `${root}/sitemap.xml`, status: "verified" });
  if (root && f.llms?.present) links.push({ label: "llms.txt", url: `${root}/llms.txt`, status: "verified" });
  return links;
}

function base64FromBytes(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function cfAccountId(env = {}) {
  return env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || env.Cloudfaire_Account_ID;
}

function browserRenderingToken(env = {}) {
  return (
    env.BROWSER_API_TOKEN ||
    env.Render_CF_KEY ||
    env.RENDER_CF_KEY ||
    env.CF_BROWSER_RENDERING_TOKEN ||
    env.CF_API_TOKEN ||
    env.Cloudfaire_API_TOKEN ||
    env.Cloudfaire_API
  );
}

function browserRenderingEnvStatus(env = {}) {
  const tokenKeys = [
    "BROWSER_API_TOKEN",
    "Render_CF_KEY",
    "RENDER_CF_KEY",
    "CF_BROWSER_RENDERING_TOKEN",
    "CF_API_TOKEN",
    "Cloudfaire_API_TOKEN",
    "Cloudfaire_API",
  ];
  const tokenSource = tokenKeys.find((key) => !!env[key]) || "";
  return {
    cf_account_id_present: !!cfAccountId(env),
    token_present: !!tokenSource,
    token_source: tokenSource,
    required_token_scope: "Cloudflare Account > Browser Rendering: Edit",
    required_plan: "Workers Paid plan with Browser Rendering enabled",
  };
}

function browserRenderingSetupMessage(status, diagnostic) {
  if (!diagnostic?.cf_account_id_present && !diagnostic?.token_present) {
    return "Missing CF_ACCOUNT_ID and BROWSER_API_TOKEN. Set both before screenshot proof can run.";
  }
  if (!diagnostic?.cf_account_id_present) {
    return "Missing CF_ACCOUNT_ID. Set the Cloudflare account id that owns Browser Rendering.";
  }
  if (!diagnostic?.token_present) {
    return "Missing BROWSER_API_TOKEN. Set a Cloudflare token with Browser Rendering: Edit permission.";
  }
  if (status === 401) {
    return "BROWSER_API_TOKEN is present, but Cloudflare returned 401. Check the token value, expiry, and that it belongs to CF_ACCOUNT_ID.";
  }
  if (status === 403) {
    return "BROWSER_API_TOKEN is present, but Cloudflare returned 403. Check Browser Rendering: Edit scope, account permissions, and Workers Paid/Browser Rendering enablement.";
  }
  return "Cloudflare Browser Rendering is not ready for screenshot proof.";
}

async function browserRenderingScreenshot(url, env, payload = {}) {
  if (payload.include_screenshot === false) return { status: "not_requested" };
  const account = cfAccountId(env);
  const token = browserRenderingToken(env);
  const diagnostic = browserRenderingEnvStatus(env);
  if (!account || !token) {
    return {
      status: "setup_required",
      note: browserRenderingSetupMessage(0, diagnostic),
      diagnostic,
    };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 22000);
  try {
    const viewport = { width: 900, height: 600 };
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/screenshot`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        url,
        viewport,
        screenshotOptions: { type: "jpeg", quality: 45, fullPage: false },
      }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 220);
      if (r.status === 401 || r.status === 403) {
        return {
          status: "setup_required",
          error: `browser_rendering_${r.status}`,
          detail,
          note: browserRenderingSetupMessage(r.status, diagnostic),
          diagnostic,
        };
      }
      return { status: "error", error: `browser_rendering_${r.status}`, detail, diagnostic };
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    const maxBytes = 450000;
    if (bytes.length > maxBytes) {
      return {
        status: "too_large",
        bytes: bytes.length,
        max_bytes: maxBytes,
        note: "Screenshot captured but not stored because it is too large for the proof record.",
        captured_at: new Date().toISOString(),
        viewport,
      };
    }
    return {
      status: "captured",
      mime_type: "image/jpeg",
      bytes: bytes.length,
      data_url: `data:image/jpeg;base64,${base64FromBytes(bytes)}`,
      captured_at: new Date().toISOString(),
      viewport,
    };
  } catch (e) {
    return { status: "error", error: String(e?.message || e).slice(0, 160), diagnostic };
  } finally {
    clearTimeout(t);
  }
}

function normalizeUrlList(values, targetUrl = "") {
  const targetHost = bareHost(targetUrl);
  const seen = new Set();
  return safeList(values, 5)
    .map(normalizeUrl)
    .filter(Boolean)
    .filter((u) => {
      const h = bareHost(u);
      if (!h || h === targetHost || seen.has(h)) return false;
      seen.add(h);
      return true;
    })
    .slice(0, 3);
}

function flattenFindings(scan) {
  const fromCategories = (scan.categories || []).flatMap((c) =>
    (c.findings || []).map((f) => ({
      category: c.name,
      check: f.check,
      status: f.status,
      severity: f.severity,
      detail: f.detail || "",
      fix: f.fix || "",
    }))
  );
  const seen = new Set(fromCategories.map(findingKey));
  const fromChecks = (scan._checks || [])
    .filter((f) => !seen.has(findingKey(f)))
    .map((f) => ({
      category: f.category,
      check: f.check,
      status: f.status,
      severity: f.severity,
      detail: f.detail || "",
      fix: "",
    }));
  return fromCategories.concat(fromChecks);
}

function snapshot(scan) {
  const findings = flattenFindings(scan);
  const fixable = findings.filter((f) => ["fail", "warn"].includes(statusOf(f)))
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5);
    })
    .slice(0, 10);
  const unverified = findings.filter((f) => statusOf(f) === "unverified").slice(0, 8);
  const facts = scan._facts || {};
  return {
    url: scan.url,
    overall: scan.overall ?? null,
    grade: scan.grade || "",
    summary: scan.summary || "",
    score_status: scan._score_status || (scan._performance_verified ? "verified" : "provisional"),
    score_note: scan._score_note || "",
    performance: scan._performance ?? scan._cwv?.performanceScore ?? null,
    performance_verified: !!scan._performance_verified,
    categories: (scan.categories || []).map((c) => ({ name: c.name, score: c.score })),
    findings: findings.slice(0, 40),
    fixable,
    unverified,
    proof_links: proofLinks(scan.url, facts),
    public_signals: {
      robots: !!facts.fetch?.robots?.present,
      sitemap: !!facts.fetch?.sitemap?.present,
      llms: !!facts.fetch?.llms?.present,
      home_status: facts.fetch?.home?.status ?? null,
    },
    at: new Date().toISOString(),
  };
}

function computeDeltas(baseline, latest) {
  if (!baseline) return null;
  const catMap = Object.fromEntries((baseline.categories || []).map((c) => [c.name, c.score]));
  const categories = (latest.categories || []).map((c) => ({
    name: c.name,
    before: catMap[c.name] ?? null,
    after: c.score,
    delta: catMap[c.name] != null ? c.score - catMap[c.name] : null,
  }));
  return {
    overall_before: baseline.overall,
    overall_after: latest.overall,
    overall_delta: (latest.overall ?? 0) - (baseline.overall ?? 0),
    grade_before: baseline.grade,
    grade_after: latest.grade,
    categories,
    days_between: baseline.at ? Math.round((Date.parse(latest.at) - Date.parse(baseline.at)) / 86400000) : null,
  };
}

function resolvedFindings(baseline, latest) {
  const before = new Map((baseline?.fixable || []).map((f) => [findingKey(f), f]));
  return (latest?.findings || latest?.fixable || [])
    .filter((f) => statusOf(f) === "pass" && before.has(findingKey(f)))
    .map((f) => ({ check: f.check, category: f.category }))
    .slice(0, 6);
}

function improvedCategories(deltas) {
  return safeList((deltas?.categories || [])
    .filter((c) => c.delta != null && c.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .map((c) => ({ category: c.name, before: c.before, after: c.after, delta: c.delta })), 6);
}

function buildNextActions(latest) {
  const actions = safeList((latest.fixable || []).map((f) => ({
    action: f.fix || `Fix ${f.check}`,
    why: `${f.category}: ${f.check}${f.detail ? ` (${f.detail})` : ""}`,
    severity: f.severity || "medium",
  })), 5);
  if (!latest.performance_verified) {
    actions.push({
      action: "Verify PageSpeed/Core Web Vitals with live quota or Search Console/CrUX data.",
      why: "Performance is held out of the score until verified.",
      severity: "info",
    });
  }
  if (!actions.length) {
    actions.push({
      action: "Run AI-citation probe and competitor benchmark to prove demand-side visibility, not only technical readiness.",
      why: "The public scan found no obvious technical gaps, so the next proof should measure market visibility.",
      severity: "info",
    });
  }
  return actions.slice(0, 6);
}

function benchmarkSummary(benchmark) {
  if (!benchmark || benchmark.status !== "completed") return null;
  const target = (benchmark.scoreboard || []).find((r) => r.role === "target");
  const bestCompetitor = (benchmark.scoreboard || []).filter((r) => r.role === "competitor" && r.ok !== false)
    .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1))[0];
  if (!target || !bestCompetitor) return null;
  const delta = scoreDelta(bestCompetitor.overall, target.overall);
  return {
    target_rank: benchmark.target_rank,
    competitor_count: benchmark.competitors_scanned || 0,
    best_competitor: bestCompetitor.url,
    overall_gap_vs_best: delta == null ? null : -delta,
    strongest_gap: (benchmark.category_gaps || [])[0] || null,
  };
}

function citationSummary(citation) {
  if (!citation) return null;
  if (citation.status !== "completed") {
    return {
      status: citation.status || "not_available",
      note: citation.setup_required || citation.error || citation.note || "",
    };
  }
  const results = citation.results || [];
  const scored = results.filter((r) => !r.error);
  return {
    status: "completed",
    observed_share_of_answer: citation.observed_share_of_answer || "0/0",
    engines_used: citation.engines_used || [],
    preview: !!citation.preview,
    cited_count: scored.filter((r) => r.cited).length,
    checked_count: scored.length,
    competitors_named: [...new Set(results.flatMap((r) => r.competitors_named || []))].slice(0, 8),
  };
}

function screenshotSummary(screenshots) {
  if (!screenshots) return null;
  const latest = screenshots.latest || screenshots;
  const baseline = screenshots.baseline || null;
  return {
    status: latest.status || "not_available",
    latest_status: latest.status || "not_available",
    baseline_status: baseline?.status || "",
    captured_at: latest.captured_at || "",
    has_latest_image: latest.status === "captured" && !!latest.data_url,
    has_baseline_image: baseline?.status === "captured" && !!baseline.data_url,
    note: latest.note || latest.error || "",
    diagnostic: latest.diagnostic || null,
  };
}

function buildProofReport({ url, account, baseline, latest, deltas, firstRun, shareId, proofUrl, citation, benchmark, screenshots }) {
  const delta = deltas ? scoreDelta(deltas.overall_before, deltas.overall_after) : 0;
  const improved = !!deltas && delta > 0;
  const declined = !!deltas && delta < 0;
  const unchanged = !!deltas && delta === 0;
  const wins = [
    ...improvedCategories(deltas).map((c) => ({
      type: "category_lift",
      text: `${c.category}: ${c.before} -> ${c.after} (${c.delta >= 0 ? "+" : ""}${c.delta})`,
    })),
    ...resolvedFindings(baseline, latest).map((f) => ({
      type: "resolved_check",
      text: `${f.category}: ${f.check}`,
    })),
  ].slice(0, 8);
  const status = firstRun ? "baseline_saved" : improved ? "improved" : declined ? "declined" : "unchanged";
  const scoreline = {
    before: baseline?.overall ?? null,
    after: latest?.overall ?? null,
    delta,
    grade_before: baseline?.grade || "",
    grade_after: latest?.grade || "",
    score_status: latest?.score_status || "provisional",
  };
  const remaining = safeList(latest.fixable || [], 8).map((f) => ({
    category: f.category,
    check: f.check,
    severity: f.severity,
    detail: f.detail,
    fix: f.fix || "",
  }));
  const verification = safeList(latest.unverified || [], 6).map((f) => ({
    category: f.category,
    check: f.check,
    detail: f.detail,
  }));
  const headlineEn = firstRun
    ? `Baseline saved at ${latest.overall}/100. Apply fixes, then re-run to prove the lift.`
    : improved
      ? `Visibility proof improved by +${delta} points (${baseline.overall} -> ${latest.overall}).`
      : declined
        ? `Visibility score dropped ${delta} points (${baseline.overall} -> ${latest.overall}); review the remaining gaps.`
        : `Visibility score is unchanged at ${latest.overall}/100; use the remaining gaps as the next fix list.`;
  const headlineTh = firstRun
    ? `บันทึก baseline ที่ ${latest.overall}/100 แล้ว หลังแก้เว็บให้กด Proof อีกครั้งเพื่อพิสูจน์ผล`
    : improved
      ? `Proof ดีขึ้น +${delta} คะแนน (${baseline.overall} -> ${latest.overall})`
      : declined
        ? `คะแนนลดลง ${delta} คะแนน (${baseline.overall} -> ${latest.overall}) ต้องตรวจ gap ที่เหลือ`
        : `คะแนนยังเท่าเดิมที่ ${latest.overall}/100 ให้ใช้ gap ที่เหลือเป็นรายการแก้รอบถัดไป`;
  return {
    url,
    account,
    status,
    headline_en: headlineEn,
    headline_th: headlineTh,
    summary_th: firstRun
      ? "นี่คือภาพก่อนแก้จาก public signals จริง เช่น meta, schema, robots, sitemap, llms.txt, Open Graph และ PageSpeed เมื่อวัดได้"
      : "นี่คือผลเทียบก่อน-หลังจากสแกนจริงรอบล่าสุด ไม่เดาคะแนน และไม่นับ PageSpeed เป็นผ่านถ้ายัง verify ไม่ได้",
    scoreline,
    wins,
    remaining_gaps: remaining,
    verification_gaps: verification,
    evidence_links: latest.proof_links || [],
    public_signals: latest.public_signals || {},
    screenshots: screenshotSummary(screenshots),
    citation_probe: citationSummary(citation),
    competitor_benchmark: benchmarkSummary(benchmark),
    next_actions: buildNextActions(latest),
    mission_coverage: {
      before_after_score: true,
      public_links: (latest.proof_links || []).length > 0,
      screenshots: screenshots?.latest?.status === "captured" ? true : (screenshots?.latest?.status || "not_available"),
      ai_citation_probe: citation?.status === "completed" ? true : (citation?.status || "not_available"),
      competitor_benchmark: benchmark?.status === "completed" ? true : (benchmark?.status || "not_requested"),
    },
    proof_id: shareId || "",
    proof_url: proofUrl || "",
    honest_note: "AI Mark proves observed public signals and before-after movement. It does not promise guaranteed ranking, guaranteed AI citations, or guaranteed revenue.",
  };
}

function publicProof(record) {
  return {
    exists: true,
    public: true,
    url: record.url || record.latest?.url,
    baseline: record.baseline,
    latest: record.latest,
    deltas: record.deltas,
    history: record.history,
    citation: record.citation || null,
    benchmark: record.benchmark || null,
    screenshots: record.screenshots || null,
    report: record.report,
    updated_at: record.updated_at,
    share_id: record.share_id,
  };
}

async function runScan(origin, url, cookieHeader, lang = "th") {
  const r = await fetch(`${origin}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    body: JSON.stringify({ url, deterministic_only: true, agent_first: true, lang }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `scan_failed_${r.status}`);
  return data;
}

function categoryScoreMap(snapshot = {}) {
  return Object.fromEntries((snapshot.categories || []).map((c) => [c.name, c.score]));
}

function strongestCategoryGaps(target, competitors) {
  const targetMap = categoryScoreMap(target);
  const gaps = [];
  for (const [name, score] of Object.entries(targetMap)) {
    const best = competitors
      .filter((c) => c.ok !== false)
      .map((c) => ({ url: c.url, score: categoryScoreMap(c)[name] }))
      .filter((c) => c.score != null)
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score > score) gaps.push({ category: name, target_score: score, best_competitor_score: best.score, gap: best.score - score, competitor: best.url });
  }
  return gaps.sort((a, b) => b.gap - a.gap).slice(0, 6);
}

async function buildCompetitorBenchmark(origin, target, competitorUrls, cookieHeader, lang) {
  if (!competitorUrls.length) return { status: "not_requested", scoreboard: [{ role: "target", url: target.url, overall: target.overall, grade: target.grade }] };
  const competitors = await Promise.all(competitorUrls.map(async (u) => {
    try {
      return { role: "competitor", ok: true, ...snapshot(await runScan(origin, u, cookieHeader, lang)) };
    } catch (e) {
      return { role: "competitor", ok: false, url: u, error: String(e?.message || e).slice(0, 160) };
    }
  }));
  const targetRow = { role: "target", ok: true, url: target.url, overall: target.overall, grade: target.grade, categories: target.categories };
  const validRows = [targetRow, ...competitors.filter((c) => c.ok !== false)]
    .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  const targetRank = validRows.findIndex((r) => r.role === "target") + 1 || null;
  const best = validRows.find((r) => r.role === "competitor") || null;
  return {
    status: "completed",
    competitors_requested: competitorUrls.length,
    competitors_scanned: competitors.filter((c) => c.ok !== false).length,
    target_rank: targetRank,
    best_competitor: best ? { url: best.url, overall: best.overall, grade: best.grade } : null,
    category_gaps: strongestCategoryGaps(target, competitors),
    scoreboard: [targetRow, ...competitors].map((r) => ({
      role: r.role,
      ok: r.ok !== false,
      url: r.url,
      overall: r.overall ?? null,
      grade: r.grade || "",
      categories: r.categories || [],
      error: r.error || "",
    })),
    honest_note: "Benchmark uses the same deterministic public-signal scan as AI Mark proof. It compares readiness signals, not guaranteed traffic or revenue.",
  };
}

async function runCitationProbe(origin, url, payload, cookieHeader) {
  if (payload.include_citation_probe === false) return { status: "not_requested" };
  try {
    const r = await fetch(`${origin}/api/citation-probe`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      body: JSON.stringify({
        url,
        business: payload.business || "",
        buyer_queries: payload.buyer_queries || payload.questions || [],
        competitors: normalizeUrlList(payload.competitors || [], url),
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) return { status: "error", error: data.error || `citation_probe_${r.status}`, detail: data.detail || "" };
    if (data.live === false || data.setup_required) return { status: "setup_required", ...data };
    return { status: "completed", ...data };
  } catch (e) {
    return { status: "error", error: String(e?.message || e).slice(0, 160) };
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const store = proofStore(env);
  const share = (u.searchParams.get("share") || "").trim();
  if (share) {
    if (!store) return json({ error: "Proof storage not bound; history unavailable." }, 501);
    const refRaw = await store.get(shareKey(share));
    if (!refRaw) return json({ error: "Proof link not found." }, 404);
    const ref = JSON.parse(refRaw);
    const raw = await store.get(ref.key || kvKey(ref.account, ref.host));
    if (!raw) return json({ error: "Proof record not found." }, 404);
    return json(publicProof(JSON.parse(raw)));
  }
  const url = normalizeUrl(u.searchParams.get("url") || "");
  if (!url) return json({ error: "Provide ?url=" }, 400);
  const account = accountOf({ account: u.searchParams.get("account"), email: u.searchParams.get("email") }, request);
  if (!store) return json({ error: "Proof storage not bound; history unavailable." }, 501);
  const raw = await store.get(kvKey(account, bareHost(url)));
  if (!raw) return json({ url, account, exists: false, note: "No proof history yet. POST to create a baseline." });
  return json({ url, account, ...JSON.parse(raw) });
}

async function handlePost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a URL." }, 400);

  const account = accountOf(payload, request);
  const origin = originOf(request, env);
  const cookieHeader = request.headers.get("cookie") || "";
  const lang = payload.lang === "en" ? "en" : "th";
  const competitorUrls = normalizeUrlList(payload.competitors || payload.competitor_urls || [], url);

  let latestScan;
  try { latestScan = await runScan(origin, url, cookieHeader, lang); }
  catch (e) { return json({ error: "Re-scan failed.", detail: String(e).slice(0, 160) }, 502); }
  const latest = snapshot(latestScan);
  const [benchmark, citation, latestScreenshot] = await Promise.all([
    buildCompetitorBenchmark(origin, latest, competitorUrls, cookieHeader, lang),
    runCitationProbe(origin, url, payload, cookieHeader),
    browserRenderingScreenshot(url, env, payload),
  ]);
  const store = proofStore(env);

  if (!store) {
    const screenshots = { baseline: latestScreenshot, latest: latestScreenshot };
    const report = buildProofReport({ url, account, baseline: latest, latest, deltas: null, firstRun: true, citation, benchmark, screenshots });
    return json({ url, account, persisted: false, latest, citation, benchmark, screenshots, report, headline: lang === "th" ? report.headline_th : report.headline_en, note: "Bind AGENT_DB or PROOF_KV to store baselines and show before/after deltas." });
  }

  const key = kvKey(account, bareHost(url));
  const raw = await store.get(key);
  const prior = raw ? JSON.parse(raw) : null;
  const baseline = prior?.baseline || latest; // first run: baseline = this scan
  const history = (prior?.history || []).concat([{ overall: latest.overall, grade: latest.grade, at: latest.at }]).slice(-12);
  const deltas = prior ? computeDeltas(baseline, latest) : null;
  const shareId = prior?.share_id || await proofShareId(account, bareHost(url));
  const proofUrl = `${origin}/api/proof?share=${encodeURIComponent(shareId)}`;
  const screenshots = {
    baseline: prior?.screenshots?.baseline || latestScreenshot,
    latest: latestScreenshot,
  };
  const report = buildProofReport({ url, account, baseline, latest, deltas, firstRun: !prior, shareId, proofUrl, citation, benchmark, screenshots });

  const record = { url, account, baseline, latest, deltas, history, citation, benchmark, screenshots, report, share_id: shareId, proof_url: proofUrl, updated_at: latest.at };
  await store.put(key, JSON.stringify(record));
  await store.put(shareKey(shareId), JSON.stringify({ key, account, host: bareHost(url), updated_at: latest.at }));

  return json({
    url, account, persisted: true,
    first_run: !prior,
    baseline, latest, deltas, history, citation, benchmark, screenshots, report,
    share_id: shareId,
    proof_url: proofUrl,
    headline: lang === "th" ? report.headline_th : report.headline_en,
  });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ error: "Proof failed.", detail: String(e?.message || e).slice(0, 200) }, 500);
  }
}
