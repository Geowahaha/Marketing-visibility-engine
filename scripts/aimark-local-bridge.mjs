#!/usr/bin/env node
/**
 * AI Mark Local Agent Bridge
 * ---------------------------------------------------------------------------
 * Runs only on this machine (127.0.0.1) and accepts handoff payloads from
 * AI Mark's browser UI. Each payload becomes a JSON + Markdown task package in
 * `.aimark-agent/inbox/` so a local AI agent/Codex session can continue work
 * from the scan, improve artifacts, or lead-scout results.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const inboxDir = path.resolve(process.env.AIMARK_AGENT_INBOX || path.join(repoRoot, ".aimark-agent", "inbox"));
const host = process.env.AIMARK_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.AIMARK_BRIDGE_PORT || 8799);
const configDir = path.resolve(process.env.AIMARK_AGENT_CONFIG || path.join(repoRoot, ".aimark-agent"));
const tokenPath = path.join(configDir, "agent-cloud-token.json");
const outboxDir = path.resolve(process.env.AIMARK_AGENT_OUTBOX || path.join(repoRoot, ".aimark-agent", "outbox"));
const args = process.argv.slice(2);
const cloudBase = String(argValue("--cloud-base") || process.env.AIMARK_CLOUD_BASE || "https://aimark.pages.dev").replace(/\/+$/, "");
const pairCode = String(argValue("--pair-code") || process.env.AIMARK_PAIR_CODE || "").trim();
const deviceCode = String(argValue("--device-code") || process.env.AIMARK_DEVICE_CODE || "").trim();
const autoRunEnabled = boolArg("--auto-run", flagEnabled(process.env.AIMARK_AGENT_AUTO_RUN));
const runnerProvider = normalizeRunnerProvider(argValue("--runner-provider") || process.env.AIMARK_AGENT_RUNNER_PROVIDER || "");
const runnerCommand = String(argValue("--runner-cmd") || process.env.AIMARK_AGENT_RUNNER_CMD || defaultRunnerCommand(runnerProvider)).trim();
const runnerMode = String(argValue("--runner-mode") || process.env.AIMARK_AGENT_RUNNER_MODE || "full-access").trim().toLowerCase();
const runnerModel = String(argValue("--runner-model") || process.env.AIMARK_AGENT_RUNNER_MODEL || defaultRunnerModel(runnerProvider)).trim();
const runnerTimeoutMs = Math.max(60_000, Number(argValue("--runner-timeout-ms") || process.env.AIMARK_AGENT_RUNNER_TIMEOUT_MS || 15 * 60_000));
const runnerDoneGraceMs = Math.max(250, Number(argValue("--runner-done-grace-ms") || process.env.AIMARK_AGENT_DONE_GRACE_MS || 8000));
const runnerCwd = path.resolve(argValue("--runner-cwd") || process.env.AIMARK_AGENT_RUNNER_CWD || repoRoot);
const runnerLogDir = path.join(configDir, "runner");
const runnerWorkspaceDir = path.join(configDir, "workspace");
let agentToken = String(process.env.AIMARK_AGENT_TOKEN || "").trim();
let cloudAgent = null;
let cloudPollingStarted = false;
let runnerActive = false;
const runnerQueue = [];
const runnerSeen = new Set();
const allowPrivateSnapshot = flagEnabled(process.env.AIMARK_ALLOW_PRIVATE_BROWSER_SNAPSHOT);
const liveBrowserHeadless = flagEnabled(process.env.AIMARK_LIVE_BROWSER_HEADLESS);
const liveBrowserState = {
  checked: false,
  playwright: null,
  detail: "",
  browser: null,
  context: null,
  page: null,
  jobId: "",
};

const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };

function argValue(name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : "";
}

function boolArg(name, fallback = false) {
  const raw = argValue(name);
  if (raw) return flagEnabled(raw);
  return args.includes(name) ? true : fallback;
}

function flagEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeRunnerProvider(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "claude" || v === "anthropic") return "claude";
  if (v === "codex" || v === "gpt" || v === "openai") return "codex";
  return "";
}

function inferRunnerProvider(command) {
  return /claude/i.test(String(command || "")) ? "claude" : "codex";
}

function defaultRunnerCommand(provider) {
  return provider === "claude" ? "claude" : "codex";
}

function defaultRunnerModel(provider) {
  return provider === "claude" ? "sonnet" : "";
}

// A Codex CLI signed in with a ChatGPT account rejects some model names
// (observed: "gpt-5-codex is not supported when using Codex with a ChatGPT account").
// Treat those as unsupported so the bridge degrades gracefully instead of failing the job.
// Empty model = let Codex pick its own default, always allowed.
function isModelSupportedByLocalCodex(model) {
  const m = String(model || "").trim().toLowerCase();
  if (!m) return true;
  const unsupported = new Set(["gpt-5-codex"]);
  for (const extra of String(process.env.AIMARK_CODEX_UNSUPPORTED_MODELS || "").split(",")) {
    const t = extra.trim().toLowerCase();
    if (t) unsupported.add(t);
  }
  return !unsupported.has(m);
}

function runnerDisplayName(config) {
  const provider = normalizeRunnerProvider(config?.provider) || inferRunnerProvider(config?.command);
  const product = provider === "claude" ? "Claude Code" : "Codex / GPT";
  return config?.model ? `${product} · ${config.model}` : product;
}

function json(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    ...corsHeaders(),
  });
  res.end(data);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-private-network": "true",
  };
}

function textOf(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeSlug(value) {
  return textOf(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "aimark-task";
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return ""; }
}

function normalizeApprovedActions(payload = {}, kind = "") {
  const raw = payload.approved_actions || payload.hermes_task?.approved_actions || [];
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const normalized = list.map((x) => textOf(x).toLowerCase()).filter(Boolean);
  const defaults = ["progress_report", "public_http_fetch"];
  if (/scan|improve|proof|analytics|site|browser/i.test(kind)) defaults.push("browser_snapshot");
  if (/live|browser_action|app_session|agent_live/i.test(kind)) defaults.push("browser_live_session");
  return [...new Set([...defaults, ...normalized])];
}

function privateHost(hostname) {
  const h = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^0\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function sameSiteOrSubdomain(targetHost, approvedHost) {
  if (!targetHost || !approvedHost) return false;
  return targetHost === approvedHost || targetHost.endsWith(`.${approvedHost}`);
}

function safeSnapshotUrl(rawUrl, job = {}) {
  let target;
  try {
    target = new URL(String(rawUrl || job.client_url || "").trim());
  } catch {
    return { ok: false, error: "invalid_snapshot_url" };
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    return { ok: false, error: "url_protocol_not_allowed" };
  }
  if (!allowPrivateSnapshot && privateHost(target.hostname)) {
    return { ok: false, error: "private_network_snapshot_blocked" };
  }
  const approvedHost = hostOf(job.client_url || "");
  const targetHost = target.hostname.replace(/^www\./i, "").toLowerCase();
  if (approvedHost && !sameSiteOrSubdomain(targetHost, approvedHost)) {
    return { ok: false, error: "target_outside_approved_site", approved_host: approvedHost, target_host: targetHost };
  }
  return { ok: true, url: target.toString(), host: targetHost };
}

function jobMatches(job = {}, jobId = "") {
  const id = String(jobId || "").trim();
  if (!id) return true;
  return String(job.id || "") === id || String(job.cloud_job_id || "") === id;
}

async function readJobForAction(jobId = "") {
  const latest = await fs.readFile(path.join(inboxDir, "latest.json"), "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({}));
  if (jobMatches(latest, jobId)) return latest;
  const names = await fs.readdir(inboxDir).catch(() => []);
  for (const name of names) {
    if (!name.endsWith(".json") || name === "latest.json") continue;
    const item = await fs.readFile(path.join(inboxDir, name), "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    if (item && jobMatches(item, jobId)) return item;
  }
  return latest;
}

async function loadPlaywright() {
  if (liveBrowserState.checked) return liveBrowserState.playwright;
  const candidates = [
    "playwright",
    pathToFileURL(path.join(repoRoot, "node_modules", "playwright", "index.js")).href,
    pathToFileURL(path.join(repoRoot, "web", "node_modules", "playwright", "index.js")).href,
  ];
  const errors = [];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      liveBrowserState.checked = true;
      liveBrowserState.playwright = mod;
      liveBrowserState.detail = specifier;
      return mod;
    } catch (err) {
      errors.push(String(err?.message || err).slice(0, 180));
    }
  }
  liveBrowserState.checked = true;
  liveBrowserState.playwright = null;
  liveBrowserState.detail = errors.find(Boolean) || "playwright_not_installed";
  return null;
}

async function checkBrowserEngineAvailability() {
  const mod = await loadPlaywright();
  return {
    available: !!mod?.chromium,
    engine: "playwright",
    detail: mod?.chromium ? liveBrowserState.detail : liveBrowserState.detail,
    headless: liveBrowserHeadless,
  };
}

function stripHtml(html = "") {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(html, regex) {
  const m = String(html || "").match(regex);
  return m ? textOf(m[1]) : "";
}

function attrOf(tag = "", name = "") {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = String(tag || "").match(re);
  return m ? textOf(m[1]) : "";
}

function absolutizeUrl(raw = "", base = "") {
  try { return new URL(raw, base || undefined).toString(); }
  catch { return textOf(raw); }
}

function extractActionables(html = "", baseUrl = "") {
  const source = String(html || "");
  const links = [];
  for (const m of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrOf(m[1], "href");
    const label = stripHtml(m[2]) || attrOf(m[1], "aria-label") || attrOf(m[1], "title");
    if (!href && !label) continue;
    links.push({ type: "link", label: textOf(label).slice(0, 100), href: absolutizeUrl(href, baseUrl) });
    if (links.length >= 12) break;
  }
  const buttons = [];
  for (const m of source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const label = stripHtml(m[2]) || attrOf(m[1], "aria-label") || attrOf(m[1], "title");
    if (!label) continue;
    buttons.push({ type: "button", label: textOf(label).slice(0, 100), name: attrOf(m[1], "name") });
    if (buttons.length >= 10) break;
  }
  const inputs = [];
  for (const m of source.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    const type = attrOf(attrs, "type") || tag;
    const label = attrOf(attrs, "aria-label") || attrOf(attrs, "placeholder") || attrOf(attrs, "name") || attrOf(attrs, "id");
    inputs.push({ type: tag, input_type: type, label: textOf(label).slice(0, 100), name: attrOf(attrs, "name"), id: attrOf(attrs, "id") });
    if (inputs.length >= 12) break;
  }
  return { links, buttons, inputs };
}

function extractSnapshotFacts(html = "", finalUrl = "", status = 0) {
  const text = stripHtml(html);
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription =
    firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i) ||
    firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  const h1 = [...String(html || "").matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripHtml(m[1])).filter(Boolean).slice(0, 5);
  const links = (String(html || "").match(/<a\b/gi) || []).length;
  const forms = (String(html || "").match(/<form\b/gi) || []).length;
  const ctas = (text.match(/contact|quote|book|buy|line|โทร|ติดต่อ|จอง|ขอใบเสนอราคา|สมัคร/gi) || []).length;
  return {
    url: finalUrl,
    status,
    title,
    meta_description: metaDescription,
    h1,
    text_chars: text.length,
    links,
    forms,
    cta_mentions: ctas,
    actionables: extractActionables(html, finalUrl),
    text_sample: text.slice(0, 900),
    captured_at: new Date().toISOString(),
  };
}

function collectFindings(scan = {}) {
  const out = [];
  for (const cat of Array.isArray(scan.categories) ? scan.categories : []) {
    for (const f of Array.isArray(cat.findings) ? cat.findings : []) {
      const status = textOf(f.status || "info").toLowerCase();
      if (status !== "fail" && status !== "warn") continue;
      out.push({
        category: cat.name || "Visibility",
        severity: textOf(f.severity || "low").toLowerCase(),
        check: f.check || "Improve visibility item",
        detail: f.detail || "",
        fix: f.fix || "",
      });
    }
  }
  return out.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9)).slice(0, 25);
}

function artifactNames(improve = {}) {
  const artifacts = improve.artifacts || {};
  return Object.entries(artifacts).map(([key, item]) => ({
    key,
    available: !!item && !item.locked && (typeof item.code === "string" || Array.isArray(item.calendar)),
    locked: !!item?.locked,
    where_to_paste: item?.where_to_paste || "",
    what_it_fixes: item?.what_it_fixes || "",
  }));
}

function normalizePayload(payload = {}) {
  const scan = payload.scan || payload.mcp_payload?.scan || payload.mcp_payload || {};
  const improve = payload.improve || payload.lastImprove || {};
  const lead = payload.lead || null;
  const leads = Array.isArray(payload.leads) ? payload.leads : [];
  const clientUrl =
    payload.client_url ||
    scan.url ||
    scan.client?.website_url ||
    improve.url ||
    lead?.url ||
    leads[0]?.url ||
    "";
  const kind = payload.kind || payload.type || (leads.length ? "lead_scout" : improve.artifacts ? "improve" : "scan");
  const id = `aimark-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${safeSlug(hostOf(clientUrl) || kind)}`;
  const cloudJobId = payload.cloud_job_id || payload.job_id || "";
  const approvedActions = normalizeApprovedActions(payload, kind);
  return {
    id,
    cloud_job_id: cloudJobId,
    kind,
    approved_actions: approvedActions,
    auto_run: payload.auto_run !== false && !payload.snapshot_only,
    source: payload.source || "AI Mark",
    source_url: payload.source_url || "",
    client_url: clientUrl,
    target_repo: payload.target_repo || "",
    notes: payload.notes || "",
    hermes_task: payload.hermes_task || null,
    runner_preference: payload.runner_preference || payload.runner || null,
    access_mode: payload.access_mode || payload.runner_preference?.mode || payload.runner?.mode || "",
    safety_notice: payload.safety_notice || "",
    scan,
    improve,
    lead,
    leads,
    findings: collectFindings(scan),
    artifacts: artifactNames(improve),
    received_at: new Date().toISOString(),
  };
}

function mdList(items, render) {
  if (!items.length) return "- None\n";
  return items.map(render).join("\n") + "\n";
}

function buildMarkdown(job) {
  const scanScore = job.scan?.overall != null ? `${job.scan.overall}/100` : "unknown";
  const grade = job.scan?.grade || "unknown";
  const leads = job.leads.length ? job.leads : (job.lead ? [job.lead] : []);
  const artifactBlock = job.artifacts.length
    ? mdList(job.artifacts, (a) => `- ${a.key}: ${a.available ? "available" : a.locked ? "locked" : "not available"}${a.where_to_paste ? ` | paste: ${a.where_to_paste}` : ""}`)
    : "- No Improve Engine artifacts included\n";
  const hermesBlock = job.hermes_task
    ? `## Hermes Task
- Goal: ${textOf(job.hermes_task.goal || job.notes || "Continue the user's requested analysis.")}
- Required data: ${(job.hermes_task.required_data || []).join(", ") || "Discover available local/customer data sources."}
- Deliverable: ${textOf(job.hermes_task.deliverable || "Return a concise evidence-based answer and next actions.")}

`
    : "";

  return `# AI Mark Agent Task

## Mission
Continue from AI Mark's analysis and turn it into concrete work.

## Context
- Task ID: ${job.id}
- Cloud Job ID: ${job.cloud_job_id || "local-only"}
- Kind: ${job.kind}
- Client URL: ${job.client_url || "not provided"}
- Scan score: ${scanScore}
- Grade: ${grade}
- Source: ${job.source}${job.source_url ? ` (${job.source_url})` : ""}
- Target repo/site access: ${job.target_repo || "discover or ask owner"}
- Approved local actions: ${(job.approved_actions || []).join(", ") || "progress_report"}
- Requested runner: ${job.runner_preference?.provider || "bridge default"}${job.runner_preference?.model ? ` / ${job.runner_preference.model}` : ""}
- Runner access mode: ${job.access_mode || job.runner_preference?.mode || "bridge default"}
- Access safety notice: ${job.safety_notice || "Respect approved scope; do not expose secrets or act outside the task."}
- Received: ${job.received_at}

## Executive Summary
${job.scan?.summary || job.improve?.business_summary || job.notes || "No summary supplied."}

${hermesBlock}
## Priority Findings
${mdList(job.findings, (f, i) => `${i + 1}. [${String(f.severity).toUpperCase()}] ${f.check}
   - Category: ${f.category}
   - Detail: ${f.detail || "No detail supplied."}
   - Fix: ${f.fix || "Inspect and implement the safest concrete improvement."}`)}

## Generated Artifacts
${artifactBlock}

## Lead Scout Queue
${mdList(leads.slice(0, 12), (l, i) => `${i + 1}. ${l.brand || l.host || l.url}
   - URL: ${l.url || ""}
   - Priority: ${l.priority_score ?? "n/a"} | weak ${l.weak_score ?? "n/a"} | ads ${l.ad_budget_signal ?? "n/a"} | leak ${l.conversion_leak_score ?? "n/a"}
   - Issues: ${(l.top_issues || []).join("; ") || "n/a"}
   - Outreach: ${textOf(l.outreach_message || "").slice(0, 800) || "n/a"}`)}

## Recommended Agent Workflow
1. Inspect the target website/repository/CMS access path.
2. Implement critical and high-impact fixes first: metadata, schema, FAQ/AEO content, robots/sitemap/llms.txt, Open Graph, and conversion path.
3. If this is a lead-scout task, pick the top 5 commercial prospects and prepare scan screenshots/messages before sending anything manually.
4. If line_oa_growth_kit is available, treat it as a LINE OA setup brief. Use LINE Official Account Manager or line-oa-mcp-ultimate through local MCP config; do not request LINE tokens inside web chat.
5. If this is a hermes_analytics task, do not guess from generic LLM knowledge. Inspect GA4, Google Search Console, UTM/campaign data, Cloudflare/server logs, referrers, and available AI crawler logs. If access is missing, report exactly which access is needed.
6. If browser_snapshot is approved, use the local bridge snapshot endpoint to inspect approved public URLs before making claims.
7. Run build/tests where available.
8. Verify the public result in browser and rerun AI Mark scan when live.
9. Report before/after score, files changed, proof links, and remaining limitations.

## Return Result To AI Mark
During work, POST live progress updates so the AI Mark web app does not go silent:

\`\`\`powershell
$progress = @{
  job_id = "${job.cloud_job_id || job.id}"
  status = "running"
  stage = "inspecting_site"
  action = "browser_check"
  target_url = "${job.client_url || ""}"
  message = "กำลังตรวจเว็บและข้อมูลจริง"
  proof_links = @()
  files = @()
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri "http://127.0.0.1:${port}/aimark/progress" -Method Post -ContentType "application/json" -Body $progress
\`\`\`

When finished, POST the result back to the local bridge so the web app can update:

\`\`\`powershell
$body = @{
  job_id = "${job.cloud_job_id || job.id}"
  status = "completed"
  summary = "Short Thai result for the owner"
  markdown = "Full report / evidence / next actions"
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri "http://127.0.0.1:${port}/aimark/result" -Method Post -ContentType "application/json" -Body $body
\`\`\`

## Guardrails
- Do not expose secrets, private lead scoring internals, API keys, or Blutenstein mechanics.
- Do not claim guaranteed Google ranking or guaranteed AI citation.
- Preserve the client's brand and visual quality.
- Do not send bulk spam. Use personalized, evidence-based outreach only.
`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function writeJob(payload) {
  const job = normalizePayload(payload);
  await fs.mkdir(inboxDir, { recursive: true });
  const md = buildMarkdown(job);
  const jsonPath = path.join(inboxDir, `${job.id}.json`);
  const mdPath = path.join(inboxDir, `${job.id}.md`);
  const latestJson = path.join(inboxDir, "latest.json");
  const latestMd = path.join(inboxDir, "latest.md");
  await fs.writeFile(jsonPath, JSON.stringify(job, null, 2), "utf8");
  await fs.writeFile(mdPath, md, "utf8");
  await fs.writeFile(latestJson, JSON.stringify(job, null, 2), "utf8");
  await fs.writeFile(latestMd, md, "utf8");
  const written = { job, jsonPath, mdPath, latestJson, latestMd };
  enqueueAutoRun(written);
  return written;
}

async function writeResult(payload = {}) {
  await fs.mkdir(outboxDir, { recursive: true });
  const latestJob = await fs.readFile(path.join(inboxDir, "latest.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => ({}));
  const jobId = String(payload.job_id || payload.cloud_job_id || latestJob.cloud_job_id || latestJob.id || "").trim();
  if (!jobId) throw new Error("job_id_required");
  const jobRunner = resolveRunnerConfig(latestJob);
  const suppliedResult = payload.result || payload.data || null;
  const resultData = suppliedResult && typeof suppliedResult === "object" && !Array.isArray(suppliedResult)
    ? suppliedResult
    : (suppliedResult == null ? {} : { data: suppliedResult });
  const result = {
    job_id: jobId,
    status: payload.status || "completed",
    summary: payload.summary || "",
    result: {
      ...resultData,
      runner_provider: resultData.runner_provider || jobRunner.provider,
      runner_command: resultData.runner_command || jobRunner.command,
      runner_model: resultData.runner_model || jobRunner.model,
      runner_mode: resultData.runner_mode || jobRunner.mode,
      runner_label: resultData.runner_label || jobRunner.label,
    },
    markdown: payload.markdown || "",
    files: Array.isArray(payload.files) ? payload.files : [],
    proof_links: Array.isArray(payload.proof_links) ? payload.proof_links : [],
    updated_at: new Date().toISOString(),
  };
  const jsonPath = path.join(outboxDir, `${safeSlug(jobId)}.json`);
  const latestPath = path.join(outboxDir, "latest-result.json");
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  await fs.writeFile(latestPath, JSON.stringify(result, null, 2), "utf8");
  let cloud = null;
  const cloudJobId = String(
    payload.cloud_job_id ||
    (String(jobId).startsWith("job_") ? jobId : "") ||
    latestJob.cloud_job_id ||
    "",
  ).trim();
  if (agentToken && cloudJobId) {
    const res = await fetch(`${cloudBase}/api/agent/jobs/result`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ ...result, job_id: cloudJobId }),
    });
    cloud = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(cloud.error || `cloud_result_failed_${res.status}`);
  }
  return { result, jsonPath, latestPath, cloud };
}

async function writeProgress(payload = {}) {
  await fs.mkdir(outboxDir, { recursive: true });
  const latestJob = await fs.readFile(path.join(inboxDir, "latest.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => ({}));
  const jobId = String(payload.job_id || payload.cloud_job_id || latestJob.cloud_job_id || latestJob.id || "").trim();
  if (!jobId) throw new Error("job_id_required");
  const jobRunner = resolveRunnerConfig(latestJob);
  const progress = {
    job_id: jobId,
    status: payload.status || "running",
    stage: payload.stage || payload.step || "agent_progress",
    action: payload.action || payload.action_type || "",
    target_url: payload.target_url || payload.url || "",
    message: payload.message || payload.summary || "",
    markdown: payload.markdown || "",
    screenshot_url: payload.screenshot_url || payload.screenshot || "",
    proof_links: Array.isArray(payload.proof_links || payload.links) ? (payload.proof_links || payload.links).slice(0, 10) : [],
    files: Array.isArray(payload.files) ? payload.files.slice(0, 20) : [],
    runner: {
      provider: jobRunner.provider,
      command: jobRunner.command,
      model: jobRunner.model,
      mode: jobRunner.mode,
      label: jobRunner.label,
    },
    updated_at: new Date().toISOString(),
  };
  const progressPath = path.join(outboxDir, `${safeSlug(jobId)}.progress.json`);
  const latestPath = path.join(outboxDir, "latest-progress.json");
  await fs.writeFile(progressPath, JSON.stringify(progress, null, 2), "utf8");
  await fs.writeFile(latestPath, JSON.stringify(progress, null, 2), "utf8");
  const cloud = await postCloudProgress({
    jobId,
    status: progress.status,
    stage: progress.stage,
    action: progress.action,
    targetUrl: progress.target_url,
    message: progress.message,
    markdown: progress.markdown,
    screenshotUrl: progress.screenshot_url,
    proofLinks: progress.proof_links,
    files: progress.files,
    runner: jobRunner,
  });
  return { progress, progressPath, latestPath, cloud };
}

async function capturePublicSnapshotEvidence({
  jobId,
  job,
  rawUrl = "",
  approvedAction = "browser_snapshot",
  progressStage = "browser_snapshot_captured",
  progressAction = "browser_snapshot",
  progressMessagePrefix = "Captured browser snapshot",
  timeoutMs = 12000,
} = {}) {
  const safe = safeSnapshotUrl(rawUrl || job.client_url, job);
  if (!safe.ok) return { error: safe.error, status: 403, job_id: jobId, detail: safe };
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), Math.max(3000, Math.min(20000, Number(timeoutMs || 12000))));
  let response;
  let html = "";
  try {
    response = await fetch(safe.url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "AI Mark Local Agent Bridge/1.0 (+https://aimark.pages.dev)" },
    });
    html = await response.text();
  } finally {
    clearTimeout(timeout);
  }
  const snapshot = {
    job_id: jobId,
    approved_action: approvedAction,
    ...extractSnapshotFacts(html, response.url || safe.url, response.status),
  };
  const snapshotPath = path.join(outboxDir, `${safeSlug(jobId)}.browser-snapshot.json`);
  const latestPath = path.join(outboxDir, "latest-browser-snapshot.json");
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.writeFile(latestPath, JSON.stringify(snapshot, null, 2), "utf8");
  const cloud = await postCloudProgress({
    jobId,
    status: "running",
    stage: progressStage,
    action: progressAction,
    targetUrl: snapshot.url,
    message: `${progressMessagePrefix}: ${snapshot.title || snapshot.url} (${snapshot.text_chars} text chars)`,
    files: [{ path: snapshotPath, status: "captured" }],
  });
  return { snapshot, snapshotPath, latestPath, cloud, status: 200 };
}

async function writeBrowserSnapshot(payload = {}) {
  await fs.mkdir(outboxDir, { recursive: true });
  const requestedJobId = String(payload.job_id || payload.cloud_job_id || "").trim();
  const latestJob = await readJobForAction(requestedJobId);
  const jobId = String(payload.job_id || payload.cloud_job_id || latestJob.cloud_job_id || latestJob.id || "").trim();
  if (!jobId) throw new Error("job_id_required");
  const approved = new Set(Array.isArray(latestJob.approved_actions) ? latestJob.approved_actions : []);
  if (!approved.has("browser_snapshot")) {
    return { error: "browser_snapshot_not_approved", status: 403, job_id: jobId };
  }
  return capturePublicSnapshotEvidence({
    jobId,
    job: latestJob,
    rawUrl: payload.url || latestJob.client_url,
    approvedAction: "browser_snapshot",
    progressStage: "browser_snapshot_captured",
    progressAction: "browser_snapshot",
    progressMessagePrefix: "Captured browser snapshot",
    timeoutMs: payload.timeout_ms,
  });
}

async function ensureLivePage(job = {}, requestedUrl = "") {
  const engine = await loadPlaywright();
  if (!engine?.chromium) {
    return {
      error: "playwright_not_available",
      status: 501,
      setup: "Install Playwright in the bridge environment or ship the signed AI Mark desktop starter with Chromium bundled.",
      detail: liveBrowserState.detail,
    };
  }
  if (!liveBrowserState.browser) {
    liveBrowserState.browser = await engine.chromium.launch({ headless: liveBrowserHeadless });
    liveBrowserState.context = await liveBrowserState.browser.newContext({
      viewport: { width: 1365, height: 900 },
      userAgent: "AI Mark Live Agent Bridge/1.0 (+https://aimark.pages.dev)",
    });
    liveBrowserState.page = await liveBrowserState.context.newPage();
  }
  const page = liveBrowserState.page;
  const target = requestedUrl || (page && page.url && page.url() !== "about:blank" ? page.url() : job.client_url);
  const safe = safeSnapshotUrl(target, job);
  if (!safe.ok) return { error: safe.error, status: 403, detail: safe };
  if (page.url() === "about:blank" || requestedUrl) {
    await page.goto(safe.url, { waitUntil: "domcontentloaded", timeout: 25000 });
  }
  liveBrowserState.jobId = job.cloud_job_id || job.id || "";
  return { page, url: safe.url, host: safe.host };
}

async function pageFacts(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const h1 = await page.locator("h1").allInnerTexts().then((items) => items.map(textOf).filter(Boolean).slice(0, 5)).catch(() => []);
  const links = await page.locator("a").count().catch(() => 0);
  const forms = await page.locator("form").count().catch(() => 0);
  const ctas = (String(text || "").match(/contact|quote|book|buy|line|โทร|ติดต่อ|จอง|ขอใบเสนอราคา|สมัคร/gi) || []).length;
  return {
    url,
    title,
    h1,
    text_chars: String(text || "").length,
    links,
    forms,
    cta_mentions: ctas,
    text_sample: String(text || "").replace(/\s+/g, " ").trim().slice(0, 900),
    captured_at: new Date().toISOString(),
  };
}

async function writeBrowserAction(payload = {}) {
  await fs.mkdir(outboxDir, { recursive: true });
  const requestedJobId = String(payload.job_id || payload.cloud_job_id || "").trim();
  const job = await readJobForAction(requestedJobId);
  const jobId = String(payload.job_id || payload.cloud_job_id || job.cloud_job_id || job.id || "").trim();
  if (!jobId) throw new Error("job_id_required");
  const approved = new Set(Array.isArray(job.approved_actions) ? job.approved_actions : []);
  if (!approved.has("browser_live_session")) {
    return { error: "browser_live_session_not_approved", status: 403, job_id: jobId };
  }

  const action = textOf(payload.action || payload.command || "extract").toLowerCase().replace(/\s+/g, "_");
  const url = String(payload.url || "").trim();
  let result = {};
  let files = [];

  if (["extract", "observe", "snapshot", "inspect_public_html"].includes(action)) {
    const snapshot = await capturePublicSnapshotEvidence({
      jobId,
      job,
      rawUrl: url || job.client_url,
      approvedAction: "browser_live_session",
      progressStage: `browser_${action}`,
      progressAction: "browser_live_session",
      progressMessagePrefix: `Live browser ${action}`,
      timeoutMs: payload.timeout_ms,
    });
    if (snapshot.error) return snapshot;
    result = { action, snapshot: snapshot.snapshot, engine: "public_http_fetch" };
    files = [{ path: snapshot.snapshotPath, status: "captured" }];
  } else if (action === "close") {
    if (liveBrowserState.browser) await liveBrowserState.browser.close().catch(() => {});
    liveBrowserState.browser = null;
    liveBrowserState.context = null;
    liveBrowserState.page = null;
    result = { action, status: "closed" };
  } else {
    const live = await ensureLivePage(job, url);
    if (live.error) return { ...live, job_id: jobId };
    const { page } = live;
    if (action === "navigate") {
      result = { action, ...(await pageFacts(page)) };
    } else if (action === "click") {
      const selector = String(payload.selector || "").trim();
      if (!selector) return { error: "selector_required", status: 400, job_id: jobId };
      await page.click(selector, { timeout: 8000 });
      result = { action, selector, ...(await pageFacts(page)) };
    } else if (action === "type" || action === "fill") {
      const selector = String(payload.selector || "").trim();
      const value = String(payload.text ?? payload.value ?? "");
      if (!selector) return { error: "selector_required", status: 400, job_id: jobId };
      await page.fill(selector, value, { timeout: 8000 });
      result = { action, selector, text_chars: value.length, ...(await pageFacts(page)) };
    } else if (action === "screenshot") {
      const shotPath = path.join(outboxDir, `${safeSlug(jobId)}.browser-live.png`);
      await page.screenshot({ path: shotPath, fullPage: true });
      result = { action, screenshot_path: shotPath, ...(await pageFacts(page)) };
      files = [{ path: shotPath, status: "captured" }];
    } else if (action === "text" || action === "read") {
      result = { action, ...(await pageFacts(page)) };
    } else {
      return { error: "browser_action_not_supported", status: 400, job_id: jobId, supported_actions: ["extract", "observe", "navigate", "click", "type", "screenshot", "text", "close"] };
    }

    const afterUrl = result.url || page.url();
    const safeAfter = safeSnapshotUrl(afterUrl, job);
    if (!safeAfter.ok) {
      return { error: "browser_left_approved_scope", status: 403, job_id: jobId, detail: safeAfter, result };
    }
  }

  const actionRecord = {
    job_id: jobId,
    approved_action: "browser_live_session",
    action,
    result,
    updated_at: new Date().toISOString(),
  };
  const actionPath = path.join(outboxDir, `${safeSlug(jobId)}.browser-action.json`);
  const latestPath = path.join(outboxDir, "latest-browser-action.json");
  await fs.writeFile(actionPath, JSON.stringify(actionRecord, null, 2), "utf8");
  await fs.writeFile(latestPath, JSON.stringify(actionRecord, null, 2), "utf8");
  const cloud = await postCloudProgress({
    jobId,
    status: "running",
    stage: `browser_${action}`,
    action: "browser_live_session",
    targetUrl: result.url || result.snapshot?.url || url || job.client_url || "",
    message: `Live browser action completed: ${action}`,
    files: [{ path: actionPath, status: "captured" }, ...files],
  });
  return { status: "browser_action_completed", job_id: jobId, action, result, action_path: actionPath, latest_action_path: latestPath, cloud };
}

async function postCloudProgress({
  jobId,
  status = "running",
  stage = "",
  action = "",
  targetUrl = "",
  message = "",
  runner = null,
  markdown = "",
  screenshotUrl = "",
  proofLinks = [],
  files = [],
} = {}) {
  const cloudJobId = String(jobId || "").trim();
  if (!agentToken || !cloudJobId || !cloudJobId.startsWith("job_")) return null;
  try {
    const res = await fetch(`${cloudBase}/api/agent/jobs/progress`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({
        job_id: cloudJobId,
        status,
        stage,
        action,
        target_url: targetUrl,
        message,
        markdown,
        screenshot_url: screenshotUrl,
        proof_links: Array.isArray(proofLinks) ? proofLinks.slice(0, 10) : [],
        files: Array.isArray(files) ? files.slice(0, 20) : [],
        runner: runner ? {
          provider: runner.provider,
          command: runner.command,
          model: runner.model,
          mode: runner.mode,
          label: runner.label,
        } : null,
        runner_label: runner?.label || "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`Cloud progress failed: ${data.error || res.status}`);
    return data;
  } catch (err) {
    console.error(`Cloud progress failed: ${String(err)}`);
    return null;
  }
}

function enqueueAutoRun(written) {
  if (!autoRunEnabled) return;
  if (written.job.auto_run === false) return;
  const key = written.job.cloud_job_id || written.job.id;
  if (runnerSeen.has(key)) return;
  runnerSeen.add(key);
  runnerQueue.push(written);
  processRunnerQueue().catch((err) => console.error(`Auto runner failed: ${String(err)}`));
}

async function enqueuePendingInboxJobs() {
  if (!autoRunEnabled) return;
  await fs.mkdir(inboxDir, { recursive: true }).catch(() => {});
  const names = await fs.readdir(inboxDir).catch(() => []);
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "latest.json") continue;
    const jsonPath = path.join(inboxDir, name);
    const job = await fs.readFile(jsonPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
    if (!job) continue;
    if (!job.cloud_job_id) continue;
    const resultJobId = job.cloud_job_id || job.id;
    if (!resultJobId) continue;
    const outPath = path.join(outboxDir, `${safeSlug(resultJobId)}.json`);
    const hasResult = await fs.stat(outPath).then(() => true).catch(() => false);
    if (hasResult) continue;
    const mdPath = jsonPath.replace(/\.json$/i, ".md");
    const stat = await fs.stat(jsonPath).catch(() => ({ mtimeMs: Date.now() }));
    jobs.push({ stat, written: { job, jsonPath, mdPath, latestJson: path.join(inboxDir, "latest.json"), latestMd: path.join(inboxDir, "latest.md") } });
  }
  jobs.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  for (const item of jobs) enqueueAutoRun(item.written);
  if (jobs.length) console.log(`Auto runner recovered ${jobs.length} pending inbox job(s).`);
}

async function processRunnerQueue() {
  if (runnerActive) return;
  runnerActive = true;
  try {
    while (runnerQueue.length) {
      const written = runnerQueue.shift();
      await runCodexJob(written);
    }
  } finally {
    runnerActive = false;
  }
}

function buildRunnerPrompt(written) {
  const resultJobId = written.job.cloud_job_id || written.job.id;
  const runner = resolveRunnerConfig(written.job);
  return `# AI Mark Hermes Full Auto Runner

You are the local ${runner.label} agent working for AI Mark. A customer approved this bridge, so continue the task autonomously on this machine.

## Job Files
- Markdown task: ${written.mdPath}
- JSON task: ${written.jsonPath}
- Result job_id: ${resultJobId}
- Local bridge result endpoint: http://${host}:${port}/aimark/result
- Local bridge live progress endpoint: http://${host}:${port}/aimark/progress
- Local bridge browser snapshot endpoint: http://${host}:${port}/aimark/browser-snapshot
- Local bridge live browser action endpoint: http://${host}:${port}/aimark/browser-action
- Suggested workspace for cloned/customer repos: ${runnerWorkspaceDir}
- Selected local runner: ${runner.label}
- Runner provider: ${runner.provider}
- Runner model: ${runner.model || "default"}
- Runner access mode: ${runner.mode}
- Approved local actions: ${(written.job.approved_actions || []).join(", ") || "progress_report"}

## Operating Rules
1. Read the Markdown task first, then inspect the JSON if needed.
2. Work end-to-end without asking the web user to copy commands.
3. Use real local files, connected repos, browser/network checks, GA/GSC/log exports, or customer-provided data when available.
4. If required access is missing, do not invent numbers. Report exactly what access is missing and the safest next step.
5. Keep secrets private. Never print API keys, OAuth tokens, cookies, or private lead scoring internals.
5a. Respect the access mode. In full-access mode you may edit files and run commands inside the approved workspace/scope when needed, but you must report risky actions and verify before deploy. In safe/sandbox mode, prefer read/analysis/browser-observe work and avoid destructive changes.
6. Run tests/build checks when the repo provides them and the risk justifies it.
7. When done, POST the final result to the local bridge. Include a Thai owner-friendly summary, evidence, files changed, proof links, and limitations.
8. While working, POST structured progress updates to /aimark/progress whenever you start a meaningful stage, inspect a URL, edit a file, capture proof, or find a blocker. Include action, target_url, files, proof_links, and screenshot_url when available. This keeps the customer-facing AI Mark app live instead of silent.
9. If "browser_snapshot" is listed in Approved local actions, you may POST {"job_id":"${resultJobId}","url":"approved public URL"} to /aimark/browser-snapshot. Use the returned title/H1/text sample as evidence. Do not inspect private/local URLs unless the bridge explicitly allows it.
10. If "browser_live_session" is listed in Approved local actions, you may POST browser actions to /aimark/browser-action. Start with {"job_id":"${resultJobId}","action":"observe","url":"approved URL"} or "extract" for a low-resource public HTML/actionable-elements read. Escalate to "navigate", "screenshot", "click", "type", or "text" only when Playwright is available and real interaction is needed. Never browse outside the approved client host.

## Required Completion Call
POST JSON to:
http://${host}:${port}/aimark/result

Payload shape:
\`\`\`json
{
  "job_id": "${resultJobId}",
  "cloud_job_id": "${written.job.cloud_job_id || ""}",
  "status": "completed",
  "summary": "short Thai result",
  "markdown": "full report with evidence and next actions",
  "files": [],
  "proof_links": []
}
\`\`\`

If the task fails because access is missing or tooling breaks, still POST with "status": "failed" and explain the exact blocker.`;
}

function resolveRunnerConfig(job = {}) {
  const pref = job.runner_preference && typeof job.runner_preference === "object" ? job.runner_preference : {};
  const prefProvider = normalizeRunnerProvider(pref.provider);
  const prefCommand = String(pref.command || "").trim();
  const provider =
    prefProvider ||
    normalizeRunnerProvider(prefCommand) ||
    normalizeRunnerProvider(runnerProvider) ||
    inferRunnerProvider(prefCommand || runnerCommand);
  // pref.command always wins. Otherwise prefer the verified local command path when it
  // matches the resolved provider — a job-level provider must NOT erase an absolute local
  // runner path (e.g. job sends provider:"codex" and the local Codex is an absolute .exe).
  // Only fall back to the bare default command when local has nothing for this provider.
  const localProvider = normalizeRunnerProvider(runnerProvider) || inferRunnerProvider(runnerCommand);
  const command =
    prefCommand ||
    (runnerCommand && localProvider === provider ? runnerCommand : defaultRunnerCommand(provider));
  let model = String(pref.model || runnerModel || defaultRunnerModel(provider)).trim();
  // Degrade an unsupported Codex model instead of failing: try the local default, else omit
  // the model entirely so Codex chooses its own.
  if (provider === "codex" && model && !isModelSupportedByLocalCodex(model)) {
    const localModel = String(runnerModel || "").trim();
    model = localModel && isModelSupportedByLocalCodex(localModel) ? localModel : "";
  }
  const mode = String(pref.mode || runnerMode || "full-access").trim().toLowerCase();
  return {
    provider,
    command,
    model,
    mode,
    label: runnerDisplayName({ provider, command, model }),
  };
}

function buildRunnerArgs(runner, { instruction, lastMessagePath }) {
  if (runner.provider === "claude") {
    const permissionMode = ["full-access", "bypass", "bypasspermissions", "unsafe"].includes(runner.mode)
      ? "bypassPermissions"
      : "auto";
    return [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      permissionMode,
      ...(runner.model ? ["--model", runner.model] : []),
      instruction,
    ];
  }
  return [
    "exec",
    "--json",
    ...(runner.mode === "full-auto" || runner.mode === "sandbox" ? ["--full-auto"] : ["--dangerously-bypass-approvals-and-sandbox"]),
    "--skip-git-repo-check",
    "--cd",
    runnerCwd,
    ...(runner.model ? ["--model", runner.model] : []),
    "--output-last-message",
    lastMessagePath,
    instruction,
  ];
}

function parseRunnerMessage(stdout, provider) {
  const raw = String(stdout || "").trim();
  if (!raw) return "";
  if (provider === "claude") {
    try {
      const data = JSON.parse(raw);
      if (data && typeof data.result === "string") return data.result;
    } catch {}
    return raw;
  }
  let lastText = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (typeof item.message === "string") lastText = item.message;
      if (typeof item.text === "string") lastText = item.text;
      const parts = item.msg?.content || item.message?.content || item.response?.output || [];
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part?.text === "string") lastText = part.text;
          if (typeof part?.content === "string") lastText = part.content;
        }
      }
    } catch {}
  }
  return lastText;
}

function trimLog(text, limit = 18000) {
  const s = String(text || "");
  return s.length > limit ? s.slice(-limit) : s;
}

function quotePowerShellArg(value) {
  const s = String(value ?? "");
  return `'${s.replace(/'/g, "''")}'`;
}

function spawnProbe(command, spawnArgs = [], timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, spawnArgs, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      resolve({ code: null, stdout, stderr, error: `probe_timeout_${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ code: null, stdout, stderr, error: String(err.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, error: "" });
    });
  });
}

async function checkRunnerAvailability(runner = {}) {
  const command = String(runner.command || "").trim().replace(/^['"]|['"]$/g, "");
  if (!command) return { available: false, command, detail: "runner_command_missing" };
  if (/[\\/]/.test(command)) {
    const ok = await fs.access(command).then(() => true).catch(() => false);
    return { available: ok, command, detail: ok ? command : "runner_command_path_not_found" };
  }
  const probe = process.platform === "win32"
    ? await spawnProbe("where.exe", [command])
    : await spawnProbe("which", [command]);
  const found = String(probe.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  return {
    available: probe.code === 0 && !!found,
    command,
    detail: found || trimLog(probe.stderr || probe.error || "runner_command_not_found", 600),
  };
}

async function runCodexJob(written) {
  const resultJobId = written.job.cloud_job_id || written.job.id;
  const slug = safeSlug(resultJobId || written.job.id);
  const runner = resolveRunnerConfig(written.job);
  await fs.mkdir(runnerLogDir, { recursive: true });
  await fs.mkdir(runnerWorkspaceDir, { recursive: true });
  await fs.mkdir(runnerCwd, { recursive: true }).catch(() => {});

  const promptPath = path.join(runnerLogDir, `${slug}.prompt.md`);
  const outLog = path.join(runnerLogDir, `${slug}.out.log`);
  const errLog = path.join(runnerLogDir, `${slug}.err.log`);
  const lastMessagePath = path.join(runnerLogDir, `${slug}.last.md`);
  const donePath = path.join(runnerLogDir, `${slug}.done.json`);
  const resultPath = path.join(outboxDir, `${safeSlug(resultJobId)}.json`);
  if (await fs.stat(resultPath).then(() => true).catch(() => false)) {
    console.log(`Auto runner skipped job ${resultJobId}; result already exists`);
    return;
  }
  await fs.writeFile(promptPath, buildRunnerPrompt(written), "utf8");

  const instruction = `Run the AI Mark Hermes job described in this file: ${promptPath}`;
  const startedAt = new Date().toISOString();
  const availability = await checkRunnerAvailability(runner);
  if (!availability.available) {
    const endedAt = new Date().toISOString();
    const markdown = `## Runner command unavailable

AI Mark could not start the selected local runner.

- Runner: ${runner.label}
- Command: ${runner.command || "not set"}
- Probe: ${availability.detail || "not found"}

Install or expose the selected CLI in PATH, or choose another runner provider/model in AI Mark and start the bridge again.`;
    const completion = {
      job_id: resultJobId,
      cloud_job_id: written.job.cloud_job_id || "",
      status: "failed",
      summary: `Local ${runner.label} ยังเริ่มไม่ได้: ไม่พบ command ${runner.command || "runner"}`,
      markdown,
      result: {
        runner: runner.command,
        runner_provider: runner.provider,
        runner_model: runner.model,
        runner_mode: runner.mode,
        runner_label: runner.label,
        runner_available: false,
        runner_probe: availability.detail,
        started_at: startedAt,
        ended_at: endedAt,
        prompt_path: promptPath,
        stdout_log: outLog,
        stderr_log: errLog,
        last_message_path: lastMessagePath,
      },
      files: [promptPath, outLog, errLog, lastMessagePath],
    };
    await fs.writeFile(outLog, "", "utf8");
    await fs.writeFile(errLog, availability.detail || "", "utf8");
    await fs.writeFile(lastMessagePath, markdown, "utf8");
    await fs.writeFile(donePath, JSON.stringify(completion, null, 2), "utf8");
    await postCloudProgress({
      jobId: resultJobId,
      status: "failed",
      stage: "runner_command_unavailable",
      message: completion.summary,
      markdown,
      runner,
    });
    await writeResult(completion);
    console.error(`Auto runner cannot start job ${resultJobId}: ${availability.detail}`);
    return;
  }
  const runnerArgs = buildRunnerArgs(runner, { instruction, lastMessagePath });
  console.log(`Auto runner starting job ${resultJobId} with ${runner.label}`);
  await postCloudProgress({
    jobId: resultJobId,
    status: "running",
    stage: "local_runner_started",
    message: `${runner.label} started on the approved local bridge.`,
    action: "runner_start",
    runner,
  });
  const run = await spawnCapture(runner.command, runnerArgs, {
    cwd: runnerCwd,
    timeoutMs: runnerTimeoutMs,
    doneFile: resultPath,
    doneGraceMs: runnerDoneGraceMs,
    env: {
      ...process.env,
      AIMARK_AGENT_JOB_ID: resultJobId,
      AIMARK_AGENT_JOB_FILE: written.mdPath,
      AIMARK_AGENT_RESULT_URL: `http://${host}:${port}/aimark/result`,
      AIMARK_AGENT_PROGRESS_URL: `http://${host}:${port}/aimark/progress`,
    },
  });
  const endedAt = new Date().toISOString();
  await fs.writeFile(outLog, run.stdout || "", "utf8");
  await fs.writeFile(errLog, run.stderr || "", "utf8");
  if (run.earlyResult) {
    const completion = {
      job_id: resultJobId,
      cloud_job_id: written.job.cloud_job_id || "",
      status: "completed",
      summary: `Local ${runner.label} ส่งผลกลับ AI Mark แล้ว`,
      result: {
        runner: runner.command,
        runner_provider: runner.provider,
        runner_model: runner.model,
        runner_mode: runner.mode,
        runner_label: runner.label,
        early_result: true,
        started_at: startedAt,
        ended_at: endedAt,
        prompt_path: promptPath,
        stdout_log: outLog,
        stderr_log: errLog,
        last_message_path: lastMessagePath,
      },
      files: [promptPath, outLog, errLog, lastMessagePath],
    };
    await fs.writeFile(donePath, JSON.stringify(completion, null, 2), "utf8");
    console.log(`Auto runner finished job ${resultJobId} after result callback`);
    return;
  }
  const parsedMessage = parseRunnerMessage(run.stdout, runner.provider);
  const lastMessage = await fs.readFile(lastMessagePath, "utf8").catch(() => "") || parsedMessage;
  const ok = run.code === 0 && !run.error;
  if (!ok) {
    await postCloudProgress({
      jobId: resultJobId,
      status: "failed",
      stage: "local_runner_failed",
      message: `${runner.label} failed before completing the job: ${run.error || `exit ${run.code ?? "unknown"}`}`,
      markdown: trimLog(run.stderr || run.stdout, 20000),
      runner,
    });
  }
  const fallbackMarkdown = lastMessage || `## ${runner.label} runner output

Exit code: ${run.code ?? "n/a"}${run.signal ? ` | signal: ${run.signal}` : ""}

### stdout
\`\`\`
${trimLog(run.stdout)}
\`\`\`

### stderr
\`\`\`
${trimLog(run.stderr)}
\`\`\`
`;
  const completion = {
    job_id: resultJobId,
    cloud_job_id: written.job.cloud_job_id || "",
    status: ok ? "completed" : "failed",
    summary: ok
      ? `Local ${runner.label} ทำงานเสร็จและส่งผลกลับ AI Mark แล้ว`
      : `Local ${runner.label} ทำงานไม่สำเร็จ: ${run.error || `exit ${run.code ?? "unknown"}`}`,
    markdown: fallbackMarkdown,
    result: {
      runner: runner.command,
      runner_provider: runner.provider,
      runner_model: runner.model,
      runner_mode: runner.mode,
      runner_label: runner.label,
      exit_code: run.code,
      signal: run.signal || null,
      error: run.error || null,
      started_at: startedAt,
      ended_at: endedAt,
      prompt_path: promptPath,
      stdout_log: outLog,
      stderr_log: errLog,
      last_message_path: lastMessagePath,
    },
    files: [promptPath, outLog, errLog, lastMessagePath],
  };
  await fs.writeFile(donePath, JSON.stringify(completion, null, 2), "utf8");
  await writeResult(completion);
  console.log(`Auto runner finished job ${resultJobId} with status ${completion.status}`);
}

function spawnCapture(command, spawnArgs, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let doneSeenAt = 0;
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "powershell.exe" : command;
    const psCommand = isWindows
      ? `& ${quotePowerShellArg(command)} ${spawnArgs.map(quotePowerShellArg).join(" ")}; exit $LASTEXITCODE`
      : "";
    const finalArgs = isWindows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand]
      : spawnArgs;
    const child = spawn(executable, finalArgs, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (doneTimer) clearInterval(doneTimer);
    };
    const killTree = () => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      cleanup();
      resolve({ code: null, signal: null, stdout, stderr, error: `runner_timeout_${options.timeoutMs || 0}ms`, timedOut: true });
    }, Math.max(60_000, Number(options.timeoutMs || runnerTimeoutMs || 15 * 60_000)));
    const doneTimer = options.doneFile ? setInterval(async () => {
      if (settled) return;
      const exists = await fs.stat(options.doneFile).then(() => true).catch(() => false);
      if (!exists) return;
      const now = Date.now();
      if (!doneSeenAt) {
        doneSeenAt = now;
        return;
      }
      if (now - doneSeenAt < Math.max(1000, Number(options.doneGraceMs || 8000))) return;
      settled = true;
      killTree();
      cleanup();
      resolve({ code: 0, signal: null, stdout, stderr, error: "", earlyResult: true });
    }, 1500) : null;
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: null, signal: null, stdout, stderr, error: String(err.message || err) });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal, stdout, stderr, error: "" });
    });
  });
}

async function loadCloudConfig() {
  if (agentToken) return;
  try {
    const raw = await fs.readFile(tokenPath, "utf8");
    const data = JSON.parse(raw);
    agentToken = String(data.agent_token || "").trim();
    cloudAgent = data.agent || null;
  } catch {
    agentToken = "";
    cloudAgent = null;
  }
}

async function saveCloudConfig(data) {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify({
    cloud_base: cloudBase,
    agent_token: data.agent_token || agentToken,
    agent: data.agent || cloudAgent,
    saved_at: new Date().toISOString(),
  }, null, 2), "utf8");
}

async function claimPairCode(code) {
  throw new Error(`pair_code_requires_browser_approval:${code || ""}`);
}

async function pollDeviceToken(code) {
  const res = await fetch(`${cloudBase}/api/agent/pair/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: code }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 428 || data.error === "authorization_pending") return { pending: true, data };
  if (!res.ok) throw new Error(data.error || data.detail || `device_token_failed_${res.status}`);
  agentToken = data.agent_token || "";
  cloudAgent = data.agent || null;
  await saveCloudConfig(data);
  return { pending: false, data };
}

async function waitForDeviceApproval(code) {
  if (!code) return null;
  for (let i = 0; i < 180; i++) {
    const result = await pollDeviceToken(code);
    if (!result.pending) return result.data;
    if (i === 0 && result.data?.verification_uri_complete) {
      console.log(`Approve this bridge: ${result.data.verification_uri_complete}`);
      console.log(`Code: ${result.data.user_code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("device_pair_timeout");
}

async function pollCloudJobsOnce() {
  if (!agentToken) return;
  const res = await fetch(`${cloudBase}/api/agent/jobs/poll`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    console.error("Cloud agent token was rejected. Pair the bridge again.");
    return;
  }
  if (!res.ok) {
    console.error(`Cloud poll failed: ${data.error || res.status}`);
    return;
  }
  cloudAgent = data.agent || cloudAgent;
  if (!data.job) return;
  const written = await writeJob({ ...(data.job.payload || data.job), cloud_job_id: data.job.id });
  await fetch(`${cloudBase}/api/agent/jobs/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ job_id: data.job.id }),
  }).catch(() => {});
  console.log(`Cloud job ${data.job.id} written to ${written.mdPath}`);
}

function startCloudPolling() {
  if (cloudPollingStarted || !agentToken) return;
  cloudPollingStarted = true;
  pollCloudJobsOnce().catch((err) => console.error(String(err)));
  setInterval(() => pollCloudJobsOnce().catch((err) => console.error(String(err))), 5000);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const healthRunner = resolveRunnerConfig();
      const runnerAvailability = await checkRunnerAvailability(healthRunner);
      const browserEngine = await checkBrowserEngineAvailability();
      return json(res, 200, {
        status: "ok",
        service: "aimark-local-agent-bridge",
        inbox: inboxDir,
        outbox: outboxDir,
        cloud_connected: !!agentToken,
        cloud_base: cloudBase,
        cloud_agent: cloudAgent,
        auto_run_enabled: autoRunEnabled,
        runner_provider: healthRunner.provider,
        runner_command: healthRunner.command,
        runner_model: healthRunner.model,
        runner_mode: healthRunner.mode,
        runner_label: healthRunner.label,
        runner_available: runnerAvailability.available,
        runner_probe: runnerAvailability.detail,
        runner_timeout_ms: runnerTimeoutMs,
        runner_done_grace_ms: runnerDoneGraceMs,
        runner_cwd: runnerCwd,
        runner_active: runnerActive,
        runner_queue_depth: runnerQueue.length,
        browser_live_session_available: browserEngine.available,
        browser_live_session_engine: browserEngine.engine,
        browser_live_session_probe: browserEngine.detail,
        browser_live_session_headless: browserEngine.headless,
      });
    }
    if (req.method === "POST" && url.pathname === "/cloud/pair") {
      const payload = await readBody(req);
      const code = payload.device_code ? "" : String(payload.user_code || payload.code || "").trim();
      const dev = String(payload.device_code || "").trim();
      if (dev) {
        waitForDeviceApproval(dev)
          .then((data) => {
            console.log(`AI Mark cloud agent paired: ${data?.agent?.device_name || "bridge"}`);
            startCloudPolling();
          })
          .catch((err) => console.error(`Cloud pairing failed: ${String(err)}`));
        return json(res, 200, { status: "pairing", cloud_base: cloudBase });
      }
      const data = await claimPairCode(code);
      startCloudPolling();
      return json(res, 200, { status: "paired", agent: data.agent || cloudAgent, cloud_base: cloudBase });
    }
    if (req.method === "POST" && url.pathname === "/aimark/ingest") {
      const payload = await readBody(req);
      const written = await writeJob(payload);
      return json(res, 200, {
        status: "accepted",
        id: written.job.id,
        kind: written.job.kind,
        client_url: written.job.client_url,
        markdown_path: written.mdPath,
        json_path: written.jsonPath,
        latest_markdown_path: written.latestMd,
        message: "Task package written to local AI agent inbox.",
      });
    }
    if (req.method === "POST" && url.pathname === "/aimark/self-test") {
      if (!autoRunEnabled) {
        return json(res, 409, {
          error: "auto_run_disabled",
          message: "Start the bridge with -AutoRun / --auto-run to test the selected local runner.",
          auto_run_enabled: false,
        });
      }
      const payload = await readBody(req).catch(() => ({}));
      const written = await writeJob({
        kind: "bridge_self_test",
        client_url: payload.client_url || "https://aimark.pages.dev/",
        notes: payload.notes || "Run a safe AI Mark bridge self-test. Do not edit files. Confirm that the local runner can read this task and return a concise result.",
        runner_preference: payload.runner_preference || payload.runner || null,
        hermes_task: {
          goal: "Run a safe local runner self-test for AI Mark. Do not edit files, install packages, contact customers, or change repositories.",
          required_data: ["this task package", "local bridge result endpoint"],
          deliverable: "Post a short completed result back to the local bridge proving the selected runner can work end-to-end.",
        },
        scan: { url: payload.client_url || "https://aimark.pages.dev/", overall: 0, grade: "self-test" },
      });
      return json(res, 200, {
        status: "self_test_started",
        id: written.job.id,
        job_id: written.job.id,
        runner: resolveRunnerConfig(written.job),
        markdown_path: written.mdPath,
        latest_result_url: `http://${host}:${port}/aimark/result/latest`,
        message: "Self-test job written and queued for the selected local runner.",
      });
    }
    if (req.method === "POST" && url.pathname === "/aimark/result") {
      const payload = await readBody(req);
      const written = await writeResult(payload);
      return json(res, 200, {
        status: "result_recorded",
        job_id: written.result.job_id,
        json_path: written.jsonPath,
        latest_result_path: written.latestPath,
        cloud: written.cloud,
      });
    }
    if (req.method === "POST" && url.pathname === "/aimark/progress") {
      const payload = await readBody(req);
      const written = await writeProgress(payload);
      return json(res, 200, {
        status: "progress_recorded",
        job_id: written.progress.job_id,
        progress_path: written.progressPath,
        latest_progress_path: written.latestPath,
        cloud: written.cloud,
      });
    }
    if (req.method === "POST" && url.pathname === "/aimark/browser-snapshot") {
      const payload = await readBody(req);
      const written = await writeBrowserSnapshot(payload);
      if (written.error) return json(res, written.status || 400, written);
      return json(res, 200, {
        status: "browser_snapshot_captured",
        job_id: written.snapshot.job_id,
        snapshot: written.snapshot,
        snapshot_path: written.snapshotPath,
        latest_snapshot_path: written.latestPath,
        cloud: written.cloud,
      });
    }
    if (req.method === "POST" && url.pathname === "/aimark/browser-action") {
      const payload = await readBody(req);
      const written = await writeBrowserAction(payload);
      if (written.error) return json(res, written.status || 400, written);
      return json(res, 200, written);
    }
    if (req.method === "GET" && url.pathname === "/aimark/result/latest") {
      const data = await fs.readFile(path.join(outboxDir, "latest-result.json"), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      return json(res, 200, { status: data ? "ok" : "empty", result: data });
    }
    if (req.method === "GET" && url.pathname === "/aimark/browser-snapshot/latest") {
      const data = await fs.readFile(path.join(outboxDir, "latest-browser-snapshot.json"), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      return json(res, 200, { status: data ? "ok" : "empty", snapshot: data });
    }
    if (req.method === "GET" && url.pathname === "/aimark/browser-action/latest") {
      const data = await fs.readFile(path.join(outboxDir, "latest-browser-action.json"), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      return json(res, 200, { status: data ? "ok" : "empty", action: data });
    }
    // Per-job reads so the browser shows the CURRENT job, never a stale global latest.
    const jobResultMatch = url.pathname.match(/^\/aimark\/jobs\/([^/]+)\/result$/);
    if (req.method === "GET" && jobResultMatch) {
      const data = await fs.readFile(path.join(outboxDir, `${safeSlug(decodeURIComponent(jobResultMatch[1]))}.json`), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      return json(res, 200, { status: data ? "ok" : "empty", result: data });
    }
    const jobProgressMatch = url.pathname.match(/^\/aimark\/jobs\/([^/]+)\/progress$/);
    if (req.method === "GET" && jobProgressMatch) {
      const data = await fs.readFile(path.join(outboxDir, `${safeSlug(decodeURIComponent(jobProgressMatch[1]))}.progress.json`), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      return json(res, 200, { status: data ? "ok" : "empty", progress: data });
    }
    if (req.method === "GET" && url.pathname === "/aimark/jobs/current") {
      const progress = await fs.readFile(path.join(outboxDir, "latest-progress.json"), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      const result = await fs.readFile(path.join(outboxDir, "latest-result.json"), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      return json(res, 200, {
        status: "ok",
        runner_active: runnerActive,
        runner_queue_depth: runnerQueue.length,
        current_job_id: progress?.job_id || (runnerActive ? result?.job_id : null) || null,
        progress,
        last_result: result,
      });
    }
    // Friendly connector status at "/" so a browser or support agent can verify the
    // connection without knowing endpoint paths (was a bare 404 before).
    if (req.method === "GET" && url.pathname === "/") {
      const statusRunner = resolveRunnerConfig();
      const latest = await fs.readFile(path.join(outboxDir, "latest-result.json"), "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      return json(res, 200, {
        service: "aimark-local-agent-bridge",
        status: "ok",
        cloud_connected: !!agentToken,
        cloud_base: cloudBase,
        runner_provider: statusRunner.provider,
        runner_label: statusRunner.label,
        runner_command: statusRunner.command,
        runner_active: runnerActive,
        runner_queue_depth: runnerQueue.length,
        last_result_job_id: latest?.job_id || null,
        last_result_status: latest?.status || null,
        endpoints: ["/health", "/aimark/jobs/current", "/aimark/jobs/:id/result", "/aimark/jobs/:id/progress", "/aimark/result/latest"],
        hint: "AI Mark local connector is running. Open AI Mark in the browser to connect this machine.",
      });
    }
    return json(res, 404, { error: "not_found" });
  } catch (err) {
    return json(res, 500, { error: "bridge_error", detail: String(err).slice(0, 500) });
  }
});

server.listen(port, host, async () => {
  await fs.mkdir(inboxDir, { recursive: true });
  await loadCloudConfig();
  console.log(`AI Mark local agent bridge listening at http://${host}:${port}`);
  console.log(`Inbox: ${inboxDir}`);
  const activeRunner = resolveRunnerConfig();
  console.log(`Auto runner: ${autoRunEnabled ? "on" : "off"}${autoRunEnabled ? ` (${activeRunner.label}, mode ${activeRunner.mode}, timeout ${runnerTimeoutMs}ms, done grace ${runnerDoneGraceMs}ms, cwd ${runnerCwd})` : ""}`);
  await enqueuePendingInboxJobs();
  if (deviceCode) {
    waitForDeviceApproval(deviceCode)
      .then((data) => {
        console.log(`AI Mark cloud agent paired: ${data?.agent?.device_name || "bridge"}`);
        startCloudPolling();
      })
      .catch((err) => console.error(`Cloud pairing failed: ${String(err)}`));
  } else if (pairCode) {
    console.error("Pair code approval must happen in the browser. Start the bridge with --device-code from the AI Mark launcher.");
  } else if (agentToken) {
    console.log(`AI Mark cloud agent connected to ${cloudBase}`);
    startCloudPolling();
  }
});
