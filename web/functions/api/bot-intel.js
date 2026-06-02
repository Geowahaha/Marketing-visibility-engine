/**
 * Cloudflare Pages Function — POST /api/bot-intel
 * ------------------------------------------------------------------
 * AI Bot Intelligence Loop: combines crawler fetch evidence, JS render gap,
 * live citation probe readiness/results, and the next agent actions.
 *
 * It does not guess traffic, rankings, or citations. It reports observed
 * evidence and names the data sources still needed.
 */

import { agentKv } from "./_agent.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function normalizeUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

function bareHost(u) {
  try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

function accountOf(payload = {}, request) {
  let fromQuery = "";
  try { fromQuery = new URL(request.url).searchParams.get("account") || ""; } catch {}
  const raw = String(payload.account || payload.email || fromQuery || "anon").trim().toLowerCase();
  return (raw || "anon").replace(/[^a-z0-9@._-]+/g, "").slice(0, 90) || "anon";
}

function botIntelStore(env = {}) {
  if (env.AGENT_DB) return agentKv(env);
  return env.PROOF_KV || env.ENTITLEMENTS_KV || null;
}

function memoryKey(account, host) {
  return `bot-intel:${account}:${host}`;
}

async function callLocal(origin, path, request, body) {
  try {
    const headers = { "content-type": "application/json" };
    const cookie = request.headers.get("cookie");
    const auth = request.headers.get("authorization");
    if (cookie) headers.cookie = cookie;
    if (auth) headers.authorization = auth;
    const r = await fetch(`${origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e).slice(0, 180) } };
  }
}

function citationRatio(value) {
  const m = String(value || "").match(/^(\d+)\/(\d+)$/);
  if (!m) return { hit: 0, total: 0, pct: null };
  const hit = Number(m[1]), total = Number(m[2]);
  return { hit, total, pct: total ? Math.round(hit * 100 / total) : null };
}

function stageMap(stages) {
  return Object.fromEntries((Array.isArray(stages) ? stages : []).map((s) => [s.id || s.label, s.status || "unknown"]));
}

function compactSnapshot({ url, botAccess, renderCheck, citation, summary, stages, actions }) {
  const cite = citationRatio(citation?.observed_share_of_answer);
  const bots = Array.isArray(botAccess?.bots) ? botAccess.bots : [];
  const hidden = renderCheck?.hidden_from_ai_pct == null ? null : Number(renderCheck.hidden_from_ai_pct);
  return {
    at: new Date().toISOString(),
    url,
    bot_can_read: Number(botAccess?.summary?.can_read || 0),
    bot_total: Number(botAccess?.summary?.total || 0),
    bot_blocked: bots.filter((b) => b.verdict && b.verdict !== "can_read").map((b) => b.bot).slice(0, 12),
    js_render_risk: !!botAccess?.js_render_risk?.likely,
    raw_html_text_chars: botAccess?.js_render_risk?.text_chars ?? null,
    hidden_from_ai_pct: Number.isFinite(hidden) ? hidden : null,
    citation_live: !!citation?.live,
    citation_share: citation?.observed_share_of_answer || "0/0",
    citation_hit: cite.hit,
    citation_total: cite.total,
    citation_pct: cite.pct,
    stage_statuses: stageMap(stages),
    blockers: safeList(summary?.blockers || [], 8),
    next_actions: safeList(actions, 8).map((a) => ({ action: a.action || "", why: a.why || "", agent_task: a.agent_task || "" })),
  };
}

function safeList(arr, limit = 8) {
  return Array.isArray(arr) ? arr.filter(Boolean).slice(0, limit) : [];
}

function numDelta(before, after) {
  if (before == null || after == null) return null;
  return Math.round((Number(after) - Number(before)) * 100) / 100;
}

function buildLearning(prior, latest, lang) {
  const th = lang === "th";
  if (!prior) {
    return {
      trend: "baseline_saved",
      headline: th
        ? "บันทึก baseline ของ AI bot intelligence แล้ว รอบถัดไปจะเทียบว่าดีขึ้นหรือถอยลง"
        : "AI bot intelligence baseline saved. The next run will compare improvement or regression.",
      deltas: null,
      next_experiment: latest.next_actions?.[0] || null,
    };
  }
  const deltas = {
    bot_can_read_delta: numDelta(prior.bot_can_read, latest.bot_can_read),
    hidden_from_ai_pct_delta: numDelta(prior.hidden_from_ai_pct, latest.hidden_from_ai_pct),
    citation_pct_delta: numDelta(prior.citation_pct, latest.citation_pct),
  };
  const improved = (deltas.bot_can_read_delta || 0) > 0 || (deltas.hidden_from_ai_pct_delta || 0) < 0 || (deltas.citation_pct_delta || 0) > 0;
  const regressed = (deltas.bot_can_read_delta || 0) < 0 || (deltas.hidden_from_ai_pct_delta || 0) > 10 || (deltas.citation_pct_delta || 0) < 0;
  const trend = regressed ? "regressed" : improved ? "improving" : "stable";
  const headline = th
    ? trend === "improving"
      ? "สัญญาณ AI bot ดีขึ้นเมื่อเทียบกับรอบก่อนหน้า"
      : trend === "regressed"
        ? "พบสัญญาณถอยลง ต้องให้ agent ตรวจ regression ก่อนแก้ต่อ"
        : "สัญญาณยังคงเดิม ให้รัน experiment ถัดไปจาก blocker ที่เหลือ"
    : trend === "improving"
      ? "AI bot visibility signals improved versus the previous observation."
      : trend === "regressed"
        ? "AI bot visibility regressed; the agent should inspect the regression before continuing."
        : "Signals are stable; run the next experiment from the remaining blockers.";
  return {
    trend,
    headline,
    prior_at: prior.at || "",
    latest_at: latest.at || "",
    deltas,
    next_experiment: latest.next_actions?.[0] || null,
  };
}

async function readMemory(store, key) {
  if (!store) return null;
  const raw = await store.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function persistMemory({ store, key, url, account, host, latest, prior }) {
  const priorHistory = Array.isArray(prior?.history) ? prior.history : [];
  const history = [...priorHistory, latest].filter(Boolean).slice(-20);
  const record = {
    url,
    account,
    host,
    baseline: prior?.baseline || latest,
    latest,
    history,
    updated_at: latest.at,
  };
  await store.put(key, JSON.stringify(record));
  return record;
}

function buildSummary({ botAccess, renderCheck, citation, lang }) {
  const th = lang === "th";
  const canRead = botAccess?.summary?.can_read ?? 0;
  const total = botAccess?.summary?.total ?? 0;
  const jsRisk = !!botAccess?.js_render_risk?.likely;
  const hidden = renderCheck?.hidden_from_ai_pct;
  const cite = citationRatio(citation?.observed_share_of_answer);
  const blockers = [];
  if (total && canRead < total) blockers.push(th ? "มี AI/search bot บางตัวอ่านไม่ได้" : "Some AI/search bots cannot read the page.");
  if (jsRisk) blockers.push(th ? "HTML ที่ bot เห็นอาจบางกว่า human view เพราะ JS-render" : "Bot-visible HTML may be thinner than the human JS-rendered view.");
  if (hidden != null && hidden > 20) blockers.push(th ? `เนื้อหา ~${hidden}% อาจซ่อนจาก bot ที่ไม่รัน JS` : `~${hidden}% of content may be hidden from JS-less bots.`);
  if (citation?.live && cite.total && cite.hit === 0) blockers.push(th ? "ยังไม่ถูก cite/name ใน probe ที่ทดสอบ" : "Not cited/named in the tested AI answer probes.");
  if (citation?.setup_required) blockers.push(th ? "ยังไม่ได้ตั้ง provider สำหรับ live citation probe ครบ" : "Live citation providers are not fully configured.");
  if (!blockers.length) blockers.push(th ? "สัญญาณ bot-access พื้นฐานดี ขั้นต่อไปคือพิสูจน์ citation และ conversion lift" : "Baseline bot-access signals look healthy; next prove citations and conversion lift.");
  return {
    headline: th
      ? `AI Bot Intelligence: bot อ่านได้ ${canRead}/${total || "?"} · ${citation?.live ? `citation ${citation.observed_share_of_answer || "0/0"}` : "citation ยังต้อง probe"}`
      : `AI Bot Intelligence: ${canRead}/${total || "?"} bots can read · ${citation?.live ? `citation ${citation.observed_share_of_answer || "0/0"}` : "citation probe pending"}`,
    blockers,
  };
}

function nextActions({ botAccess, renderCheck, citation, lang }) {
  const th = lang === "th";
  const actions = [];
  const blockedBots = (botAccess?.bots || []).filter((b) => b.verdict !== "can_read");
  if (blockedBots.length) {
    actions.push({
      action: th ? "แก้ crawler access" : "Fix crawler access",
      why: blockedBots.slice(0, 3).map((b) => b.bot).join(", "),
      agent_task: "Inspect robots.txt, firewall, bot challenge, login wall, and server responses for AI/search crawler user agents.",
    });
  }
  if (botAccess?.js_render_risk?.likely || Number(renderCheck?.hidden_from_ai_pct || 0) > 20) {
    actions.push({
      action: th ? "ทำ key content ให้เป็น server-rendered/pre-rendered" : "Server-render or pre-render key content",
      why: renderCheck?.headline || botAccess?.js_render_risk?.note || "",
      agent_task: "Ensure service, FAQ, pricing cues, trust proof, schema, and CTAs exist in raw HTML before JavaScript.",
    });
  }
  if (!citation?.live || citation?.setup_required) {
    actions.push({
      action: th ? "เปิด live AI citation probes" : "Enable live AI citation probes",
      why: citation?.setup_required || "Need Gemini/Perplexity/Tavily/SerpAPI evidence.",
      agent_task: "Configure provider keys and run buyer-query probes without claiming guaranteed ranking.",
    });
  } else if (citationRatio(citation.observed_share_of_answer).hit === 0) {
    actions.push({
      action: th ? "สร้าง answer-led pages ให้ AI cite ได้" : "Create answer-led pages AI can cite",
      why: th ? "probe ยังไม่พบ brand/domain ในคำตอบ" : "The probe did not observe the brand/domain in answers.",
      agent_task: "Create FAQ/entity/service proof pages with schema, internal links, and public proof links.",
    });
  }
  actions.push({
    action: th ? "วน Proof Loop หลังแก้" : "Run proof loop after fixes",
    why: th ? "บันทึก before/after, screenshot, citation, benchmark" : "Capture before/after score, screenshot, citation, and benchmark evidence.",
    agent_task: "Apply fixes, deploy, rerun AI Mark proof, and report observed deltas.",
  });
  return actions;
}

export async function onRequestPost({ request, env }) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a URL." }, 400);
  const host = bareHost(url);
  const account = accountOf(payload, request);
  const lang = payload.lang === "en" ? "en" : "th";
  const origin = String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
  const base = { url, scan: payload.scan || null, lang, competitors: payload.competitors || [] };

  const [botAccessRes, citationRes, renderRes] = await Promise.all([
    callLocal(origin, "/api/bot-access", request, base),
    callLocal(origin, "/api/citation-probe", request, { ...base, include_preview: true }),
    payload.include_render_check === false
      ? Promise.resolve({ ok: true, status: 200, data: { skipped: true, note: "render_check_not_requested" } })
      : callLocal(origin, "/api/render-check", request, { ...base, screenshot: false }),
  ]);

  const botAccess = botAccessRes.data || {};
  const citation = citationRes.data || {};
  const renderCheck = renderRes.data || {};
  const summary = buildSummary({ botAccess, citation, renderCheck, lang });
  const actions = nextActions({ botAccess, citation, renderCheck, lang });
  const stages = [
    { id: "crawler_fetch", label: "AI/search crawler fetch", status: botAccessRes.ok ? "observed" : "error" },
    { id: "human_vs_bot_render", label: "Human vs bot render gap", status: renderRes.status === 402 ? "locked" : renderCheck.live === false ? "setup_required" : renderRes.ok ? "observed" : "error" },
    { id: "live_ai_answers", label: "Live AI citation probe", status: citation.live ? "observed" : citation.setup_required ? "setup_required" : citationRes.status === 402 ? "locked" : "not_available" },
    { id: "agent_fix_loop", label: "Agent fix loop", status: "ready_for_handoff" },
    { id: "proof_loop", label: "Before/after proof", status: "ready" },
  ];
  const latestObservation = compactSnapshot({ url, botAccess, citation, renderCheck, summary, stages, actions });
  const store = botIntelStore(env);
  const persistRequested = payload.persist !== false;
  let record = null;
  let prior = null;
  let learning = buildLearning(null, latestObservation, lang);
  let evidenceMemory = {
    enabled: !!store,
    persist_requested: persistRequested,
    persisted: false,
    account,
    host,
    observations: 0,
  };
  if (store && persistRequested) {
    try {
      const key = memoryKey(account, host);
      prior = await readMemory(store, key);
      const previous = prior?.latest || safeList(prior?.history || [], 20).slice(-1)[0] || null;
      learning = buildLearning(previous, latestObservation, lang);
      record = await persistMemory({ store, key, url, account, host, latest: latestObservation, prior });
      evidenceMemory = {
        enabled: true,
        persist_requested: true,
        persisted: true,
        first_observation: !prior,
        account,
        host,
        observations: record.history.length,
        baseline_at: record.baseline?.at || "",
        prior_at: previous?.at || "",
        latest_at: latestObservation.at,
      };
    } catch (e) {
      evidenceMemory.error = String(e?.message || e).slice(0, 160);
    }
  }

  return json({
    url,
    generated_at: new Date().toISOString(),
    status: "observed",
    intelligence_loop: {
      stages,
      differentiator: lang === "th"
        ? "AI Mark ไม่หยุดที่ SEO checklist แต่จำลองมุมมอง AI/search bot, human render, live answer probes และส่งงานแก้ให้ agent วนพิสูจน์ผล"
        : "AI Mark goes beyond SEO checklists by simulating AI/search bot views, human render, live answer probes, and agent-driven proof loops.",
    },
    evidence_memory: evidenceMemory,
    learning_loop: learning,
    current_observation: latestObservation,
    summary,
    bot_access: botAccess,
    render_check: renderCheck,
    citation_probe: citation,
    next_actions: actions,
    agent_handoff: {
      kind: "ai_bot_intelligence_loop",
      goal: "Continuously improve AI-search/GEO/AEO visibility from observed bot-access, render-gap, citation, and proof evidence.",
      required_data: ["bot-access results", "human-vs-bot render gap", "live AI citation probe", "scan/proof baseline", "repo or CMS access"],
      deliverable: "Thai owner-friendly report, files changed, proof links, remaining blockers, and next experiment.",
    },
    honest_note: "This loop observes what our controlled probes can see today. Real AI/search systems vary by crawler identity, location, personalization, and time, so AI Mark stores evidence and repeats the loop instead of claiming permanent rankings.",
  });
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const url = normalizeUrl(u.searchParams.get("url") || "");
  if (!url) return json({ error: "Provide ?url=" }, 400);
  const host = bareHost(url);
  const account = accountOf({ account: u.searchParams.get("account") || "" }, request);
  const store = botIntelStore(env);
  if (!store) return json({ error: "Bot intelligence storage not bound; history unavailable." }, 501);
  const record = await readMemory(store, memoryKey(account, host));
  if (!record) {
    return json({
      url,
      account,
      host,
      exists: false,
      note: "No AI Bot Intelligence history yet. POST /api/bot-intel to create the first observation.",
    });
  }
  return json({
    url,
    account,
    host,
    exists: true,
    baseline: record.baseline,
    latest: record.latest,
    history: safeList(record.history || [], 20),
    updated_at: record.updated_at || record.latest?.at || "",
  });
}
