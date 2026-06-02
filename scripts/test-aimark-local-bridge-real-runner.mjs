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
const args = process.argv.slice(2);

function argValue(name, fallback = "") {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

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

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function waitForJson(url, predicate, timeoutMs = 180000) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await fetchJson(url);
      if (predicate(latest)) return latest;
    } catch {}
    await delay(1000);
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

const provider = String(argValue("--runner-provider", "codex")).toLowerCase();
const command = argValue("--runner-cmd", provider === "claude" ? "claude" : "codex");
const model = argValue("--runner-model", "");
const mode = argValue("--runner-mode", "full-auto");
const timeoutMs = Number(argValue("--timeout-ms", "180000"));
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aimark-real-runner-"));
const runnerWorkspace = path.join(tempDir, "workspace");
await fs.mkdir(runnerWorkspace, { recursive: true });
const { server: cloudServer } = createFakeCloud();
const cloudAddress = await listen(cloudServer);
const bridgePort = await freePort();
let bridge = null;

try {
  const env = {
    ...process.env,
    AIMARK_BRIDGE_PORT: String(bridgePort),
    AIMARK_AGENT_CONFIG: path.join(tempDir, "config"),
    AIMARK_AGENT_INBOX: path.join(tempDir, "inbox"),
    AIMARK_AGENT_OUTBOX: path.join(tempDir, "outbox"),
    AIMARK_AGENT_AUTO_RUN: "1",
    AIMARK_AGENT_TOKEN: "real-runner-test-token",
    AIMARK_AGENT_DONE_GRACE_MS: "1000",
    AIMARK_AGENT_RUNNER_TIMEOUT_MS: String(Math.max(60000, timeoutMs)),
  };
  const stdout = [];
  const stderr = [];
  bridge = spawn(process.execPath, [
    bridgeScript,
    "--cloud-base", `http://127.0.0.1:${cloudAddress.port}`,
    "--runner-provider", provider,
    "--runner-cmd", command,
    "--runner-mode", mode,
    "--runner-cwd", runnerWorkspace,
    ...(model ? ["--runner-model", model] : []),
  ], {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  bridge.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const health = await waitForJson(`http://127.0.0.1:${bridgePort}/health`, (r) => r.status === 200 && r.data.status === "ok", 30000);
  assert.equal(health.data.auto_run_enabled, true);
  assert.equal(health.data.runner_available, true);
  assert.equal(health.data.runner_command, command);
  assert.equal(health.data.runner_cwd, runnerWorkspace);

  const start = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/self-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_url: "https://aimark.pages.dev/",
      notes: [
        "Real runner smoke test for AI Mark.",
        "Do not edit files.",
        "Return a concise final answer only.",
        "If you do not POST to the bridge yourself, the bridge fallback result is acceptable.",
      ].join(" "),
    }),
  });
  assert.equal(start.status, 200);
  assert.equal(start.data.status, "self_test_started");

  const latest = await waitForJson(
    `http://127.0.0.1:${bridgePort}/aimark/result/latest`,
    (r) => r.status === 200 && r.data.result?.job_id === start.data.job_id && ["completed", "failed"].includes(r.data.result?.status),
    timeoutMs + 30000,
  );
  assert.equal(latest.data.result.job_id, start.data.job_id);
  assert.ok(latest.data.result.summary || latest.data.result.markdown, "expected a runner summary or markdown result");
  assert.equal(latest.data.result.result.runner_provider, provider);
  assert.equal(latest.data.result.result.runner_label, health.data.runner_label);

  if (latest.data.result.status !== "completed") {
    throw new Error(`real runner self-test failed: ${latest.data.result.summary}\n${latest.data.result.markdown || ""}`);
  }

  console.log(`local-bridge-real-runner: ok (${health.data.runner_label})`);
} finally {
  stopProcess(bridge);
  await closeServer(cloudServer).catch(() => {});
  await delay(500);
  if (!args.includes("--keep-temp")) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  else console.log(`kept temp dir: ${tempDir}`);
}
