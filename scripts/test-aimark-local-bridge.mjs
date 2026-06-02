#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const bridgeScript = path.join(repoRoot, "scripts", "aimark-local-bridge.mjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server, port = 0, host = "127.0.0.1") {
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort() {
  const server = http.createServer();
  const address = await listen(server);
  await closeServer(server);
  return address.port;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function createFakeCloud() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || "", body });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", visible_to_user: true }));
  });
  return { server, requests };
}

async function writeMockRunner(tempDir) {
  const runnerJs = path.join(tempDir, "mock-runner.mjs");
  await fs.writeFile(runnerJs, `
const resultUrl = process.env.AIMARK_AGENT_RESULT_URL;
const progressUrl = process.env.AIMARK_AGENT_PROGRESS_URL;
const jobId = process.env.AIMARK_AGENT_JOB_ID;
if (!resultUrl || !jobId) {
  console.error("missing AIMARK_AGENT_RESULT_URL or AIMARK_AGENT_JOB_ID");
  process.exit(2);
}
if (progressUrl) {
  const progressResponse = await fetch(progressUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      status: "running",
      stage: "mock_mid_run",
      action: "browser_check",
      target_url: "https://example.com/",
      message: "Mock runner is working live",
      screenshot_url: "https://example.com/mock-shot.png",
      proof_links: ["https://example.com/mock-proof-live"],
      files: [{ path: "mock-live.md", status: "drafted" }]
    })
  });
  if (!progressResponse.ok) {
    console.error(await progressResponse.text());
    process.exit(4);
  }
}
await new Promise((resolve) => setTimeout(resolve, 150));
const response = await fetch(resultUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    job_id: jobId,
    status: "completed",
    summary: "Mock local runner completed " + jobId,
    markdown: "## Mock runner result\\n- Proof returned through the local bridge\\n- No cloud LLM was used",
    result: {
      runner_label: "Mock Hermes Runner",
      runner_provider: "test",
      evidence_count: 2
    },
    files: ["mock-output.md"],
    proof_links: ["https://example.com/mock-proof"]
  })
});
if (!response.ok) {
  console.error(await response.text());
  process.exit(3);
}
await new Promise((resolve) => setTimeout(resolve, 5000));
`, "utf8");

  if (process.platform === "win32") {
    const runnerCmd = path.join(tempDir, "mock-runner.cmd");
    await fs.writeFile(runnerCmd, `@echo off\r\nnode "%~dp0mock-runner.mjs" %*\r\n`, "utf8");
    return runnerCmd;
  }

  const runnerSh = path.join(tempDir, "mock-runner.sh");
  await fs.writeFile(runnerSh, `#!/usr/bin/env sh\nnode "$(dirname "$0")/mock-runner.mjs" "$@"\n`, "utf8");
  await fs.chmod(runnerSh, 0o755);
  return runnerSh;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function waitForJson(url, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await fetchJson(url);
      if (predicate(latest)) return latest;
    } catch {}
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}; latest=${JSON.stringify(latest)}`);
}

function stopProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aimark-bridge-e2e-"));
const { server: cloudServer, requests: cloudRequests } = createFakeCloud();
const cloudAddress = await listen(cloudServer);
const targetServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
    <html><head>
      <title>AI Mark Snapshot Target</title>
      <meta name="description" content="Snapshot target for AI Mark bridge tests.">
    </head><body>
      <h1>Snapshot Proof Page</h1>
      <p>Contact us on LINE for a quote. This page has public buyer proof text.</p>
      <a href="/contact">Contact</a>
    </body></html>`);
});
const targetAddress = await listen(targetServer);
const targetUrl = `http://127.0.0.1:${targetAddress.port}/`;
const bridgePort = await freePort();
const runnerCmd = await writeMockRunner(tempDir);
let bridge = null;

try {
  const env = {
    ...process.env,
    AIMARK_BRIDGE_PORT: String(bridgePort),
    AIMARK_AGENT_CONFIG: path.join(tempDir, "config"),
    AIMARK_AGENT_INBOX: path.join(tempDir, "inbox"),
    AIMARK_AGENT_OUTBOX: path.join(tempDir, "outbox"),
    AIMARK_AGENT_AUTO_RUN: "1",
    AIMARK_AGENT_TOKEN: "test-agent-token",
    AIMARK_AGENT_DONE_GRACE_MS: "500",
    AIMARK_AGENT_RUNNER_TIMEOUT_MS: "60000",
    AIMARK_ALLOW_PRIVATE_BROWSER_SNAPSHOT: "1",
  };
  const stdout = [];
  const stderr = [];
  bridge = spawn(process.execPath, [
    bridgeScript,
    "--cloud-base", `http://127.0.0.1:${cloudAddress.port}`,
    "--runner-provider", "claude",
    "--runner-cmd", runnerCmd,
    "--runner-model", "mock",
    "--runner-mode", "full-access",
  ], {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const health = await waitForJson(`http://127.0.0.1:${bridgePort}/health`, (r) => r.status === 200 && r.data.status === "ok");
  assert.equal(health.data.auto_run_enabled, true);
  assert.equal(health.data.runner_available, true);
  assert.equal(health.data.runner_done_grace_ms, 500);
  assert.match(health.data.runner_label, /Claude Code/);
  assert.equal(typeof health.data.browser_live_session_available, "boolean");
  assert.equal(health.data.browser_live_session_engine, "playwright");

  const snapshotOnly = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "browser_snapshot",
      client_url: targetUrl,
      snapshot_only: true,
      auto_run: false,
      approved_actions: ["browser_snapshot", "browser_live_session", "progress_report"],
      notes: "UI-triggered snapshot should not start the auto runner.",
    }),
  });
  assert.equal(snapshotOnly.status, 200);
  assert.equal(snapshotOnly.data.status, "accepted");

  const uiSnapshot = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: snapshotOnly.data.id,
      url: targetUrl,
    }),
  });
  assert.equal(uiSnapshot.status, 200);
  assert.equal(uiSnapshot.data.status, "browser_snapshot_captured");
  assert.equal(uiSnapshot.data.snapshot.title, "AI Mark Snapshot Target");
  const latestSnapshot = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-snapshot/latest`);
  assert.equal(latestSnapshot.status, 200);
  assert.equal(latestSnapshot.data.snapshot.job_id, snapshotOnly.data.id);
  const liveExtract = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: snapshotOnly.data.id,
      action: "extract",
      url: targetUrl,
    }),
  });
  assert.equal(liveExtract.status, 200);
  assert.equal(liveExtract.data.status, "browser_action_completed");
  assert.equal(liveExtract.data.action, "extract");
  assert.equal(liveExtract.data.result.snapshot.title, "AI Mark Snapshot Target");
  const deniedLiveExtract = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: snapshotOnly.data.id,
      action: "extract",
      url: "https://outside.example/",
    }),
  });
  assert.equal(deniedLiveExtract.status, 403);
  assert.equal(deniedLiveExtract.data.error, "target_outside_approved_site");

  const liveOnly = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "live_agent_session",
      client_url: targetUrl,
      snapshot_only: true,
      auto_run: false,
      approved_actions: ["browser_live_session", "progress_report"],
      notes: "Live session observe should not require browser_snapshot permission.",
    }),
  });
  assert.equal(liveOnly.status, 200);
  assert.equal(liveOnly.data.status, "accepted");
  const liveOnlyExtract = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: liveOnly.data.id,
      action: "observe",
      url: targetUrl,
    }),
  });
  assert.equal(liveOnlyExtract.status, 200);
  assert.equal(liveOnlyExtract.data.status, "browser_action_completed");
  assert.equal(liveOnlyExtract.data.result.snapshot.approved_action, "browser_live_session");
  assert.equal(liveOnlyExtract.data.result.snapshot.title, "AI Mark Snapshot Target");
  const liveOnlySnapshotDenied = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: liveOnly.data.id,
      url: targetUrl,
    }),
  });
  assert.equal(liveOnlySnapshotDenied.status, 403);
  assert.equal(liveOnlySnapshotDenied.data.error, "browser_snapshot_not_approved");
  await delay(700);
  const noAutoRunResult = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/result/latest`);
  assert.equal(noAutoRunResult.data.status, "empty", "snapshot-only ingest must not auto-run the local runner");

  const ingest = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cloud_job_id: "job_bridge_e2e",
      kind: "hermes_site_improvement",
      client_url: targetUrl,
      approved_actions: ["browser_snapshot", "browser_live_session", "progress_report"],
      notes: "Run the bridge integration test and return proof.",
      hermes_task: {
        goal: "Return a deterministic proof result through the local bridge.",
        deliverable: "Completed local result.",
      },
      scan: { url: targetUrl, overall: 72, grade: "B" },
    }),
  });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.data.status, "accepted");

  const snapshot = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: "job_bridge_e2e",
      url: targetUrl,
    }),
  });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.status, "browser_snapshot_captured");
  assert.equal(snapshot.data.snapshot.title, "AI Mark Snapshot Target");
  assert.equal(snapshot.data.snapshot.h1[0], "Snapshot Proof Page");
  assert.ok(snapshot.data.snapshot.text_chars > 60);

  const deniedSnapshot = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/browser-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: "job_bridge_e2e",
      url: "https://outside.example/",
    }),
  });
  assert.equal(deniedSnapshot.status, 403);
  assert.equal(deniedSnapshot.data.error, "target_outside_approved_site");

  const latest = await waitForJson(
    `http://127.0.0.1:${bridgePort}/aimark/result/latest`,
    (r) => r.status === 200 && r.data.result?.job_id === "job_bridge_e2e" && r.data.result?.status === "completed",
  );
  assert.equal(latest.data.result.summary, "Mock local runner completed job_bridge_e2e");
  assert.equal(latest.data.result.result.runner_label, "Mock Hermes Runner");
  assert.match(latest.data.result.markdown, /Proof returned through the local bridge/);

  const progress = cloudRequests.find((r) => r.url === "/api/agent/jobs/progress" && r.body.stage === "local_runner_started");
  assert.ok(progress, `expected running progress callback; got ${JSON.stringify(cloudRequests)}`);
  assert.equal(progress.authorization, "Bearer test-agent-token");
  assert.equal(progress.body.job_id, "job_bridge_e2e");
  assert.equal(progress.body.stage, "local_runner_started");

  const liveProgress = cloudRequests.find((r) => r.url === "/api/agent/jobs/progress" && r.body.stage === "mock_mid_run");
  assert.ok(liveProgress, `expected live runner progress callback; got ${JSON.stringify(cloudRequests)}`);
  assert.equal(liveProgress.body.job_id, "job_bridge_e2e");
  assert.equal(liveProgress.body.action, "browser_check");
  assert.equal(liveProgress.body.target_url, "https://example.com/");
  assert.equal(liveProgress.body.message, "Mock runner is working live");
  assert.equal(liveProgress.body.screenshot_url, "https://example.com/mock-shot.png");
  assert.equal(liveProgress.body.proof_links[0], "https://example.com/mock-proof-live");
  assert.equal(liveProgress.body.files[0].path, "mock-live.md");

  const snapshotProgress = cloudRequests.find((r) => r.url === "/api/agent/jobs/progress" && r.body.stage === "browser_snapshot_captured");
  assert.ok(snapshotProgress, `expected browser snapshot progress callback; got ${JSON.stringify(cloudRequests)}`);
  assert.equal(snapshotProgress.body.action, "browser_snapshot");
  assert.equal(snapshotProgress.body.target_url, targetUrl);
  assert.equal(snapshotProgress.body.files[0].status, "captured");

  const cloudResult = cloudRequests.find((r) => r.url === "/api/agent/jobs/result" && r.body.job_id === "job_bridge_e2e");
  assert.ok(cloudResult, `expected cloud result callback; got ${JSON.stringify(cloudRequests)}`);
  assert.equal(cloudResult.body.status, "completed");

  const runnerLogs = await fs.readdir(path.join(tempDir, "config", "runner"));
  assert.ok(runnerLogs.some((name) => name.endsWith(".prompt.md")), `expected prompt log; got ${runnerLogs.join(",")}`);

  const selfTest = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/self-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      notes: "Run the local self-test route.",
    }),
  });
  assert.equal(selfTest.status, 200);
  assert.equal(selfTest.data.status, "self_test_started");
  assert.match(selfTest.data.job_id, /^aimark-/);
  assert.equal(selfTest.data.runner.available, undefined);

  const selfLatest = await waitForJson(
    `http://127.0.0.1:${bridgePort}/aimark/result/latest`,
    (r) => r.status === 200 && r.data.result?.job_id === selfTest.data.job_id && r.data.result?.status === "completed",
  );
  assert.equal(selfLatest.data.result.summary, `Mock local runner completed ${selfTest.data.job_id}`);
  assert.match(selfLatest.data.result.markdown, /Proof returned through the local bridge/);

  console.log("local-bridge-e2e: ok");
} finally {
  stopProcess(bridge);
  await closeServer(cloudServer).catch(() => {});
  await closeServer(targetServer).catch(() => {});
  await delay(250);
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
