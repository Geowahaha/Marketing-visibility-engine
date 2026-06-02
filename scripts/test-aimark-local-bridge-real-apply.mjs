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
  return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
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

async function waitForJson(url, predicate, timeoutMs = 360000) {
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

async function seedWorkspace(workspace) {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "index.html"), `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Mark Test Clinic</title>
</head>
<body>
  <main>
    <h1>AI Mark Test Clinic</h1>
    <p>Starter website used by the AI Mark local bridge apply smoke test.</p>
  </main>
</body>
</html>
`, "utf8");
  await fs.writeFile(path.join(workspace, "README.md"), "Temporary customer workspace for AI Mark bridge apply smoke.\n", "utf8");
}

const provider = String(argValue("--runner-provider", "codex")).toLowerCase();
const command = argValue("--runner-cmd", provider === "claude" ? "claude" : "codex");
const model = argValue("--runner-model", "");
const mode = argValue("--runner-mode", "full-access");
const timeoutMs = Number(argValue("--timeout-ms", "360000"));
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aimark-real-apply-"));
const runnerWorkspace = path.join(tempDir, "customer-site");
await seedWorkspace(runnerWorkspace);
const { server: cloudServer, requests: cloudRequests } = createFakeCloud();
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
    AIMARK_AGENT_TOKEN: "real-apply-test-token",
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
  assert.equal(health.data.runner_cwd, runnerWorkspace);

  const indexPath = path.join(runnerWorkspace, "index.html").replace(/\\/g, "/");
  const proofPath = path.join(runnerWorkspace, "aimark-proof.md").replace(/\\/g, "/");
  const ingest = await fetchJson(`http://127.0.0.1:${bridgePort}/aimark/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cloud_job_id: "job_real_apply_smoke",
      kind: "hermes_site_improvement",
      client_url: "https://customer.local/",
      target_repo: runnerWorkspace,
      notes: [
        "AI Mark real-runner apply smoke test.",
        `Work only inside this temporary workspace: ${runnerWorkspace.replace(/\\/g, "/")}`,
        `Edit exactly this file: ${indexPath}`,
        "Add a meta description if it is missing.",
        "Add JSON-LD with id=\"aimark-schema\", @context https://schema.org, @type LocalBusiness, name AI Mark Test Clinic, url https://customer.local/ before </head>.",
        `Create this proof file: ${proofPath}`,
        "The proof file must include the lines: AI Mark apply smoke passed, index.html, aimark-schema.",
        "Do not install packages. Do not edit files outside the temporary workspace. Do not contact customers.",
      ].join(" "),
      hermes_task: {
        goal: "Apply safe AI Mark visibility fixes to a temporary customer workspace and report proof through the bridge.",
        required_data: ["index.html in the temp workspace", "this task package"],
        deliverable: "Modified index.html, aimark-proof.md, and a concise result back to AI Mark.",
      },
      scan: {
        url: "https://customer.local/",
        overall: 55,
        grade: "C",
        summary: "Synthetic customer site lacks meta description and schema.",
        categories: [{
          name: "Technical SEO",
          findings: [
            { status: "fail", severity: "high", check: "Meta description", detail: "Missing", fix: "Add a concise customer-facing meta description." },
            { status: "fail", severity: "high", check: "Structured data", detail: "Missing", fix: "Add LocalBusiness JSON-LD." },
          ],
        }],
      },
    }),
  });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.data.status, "accepted");

  const latest = await waitForJson(
    `http://127.0.0.1:${bridgePort}/aimark/result/latest`,
    (r) => r.status === 200 && r.data.result?.job_id === "job_real_apply_smoke" && ["completed", "failed"].includes(r.data.result?.status),
    timeoutMs + 30000,
  );
  if (latest.data.result.status !== "completed") {
    throw new Error(`real apply runner failed: ${latest.data.result.summary}\n${latest.data.result.markdown || ""}`);
  }

  const [indexHtml, proofMd] = await Promise.all([
    fs.readFile(path.join(runnerWorkspace, "index.html"), "utf8"),
    fs.readFile(path.join(runnerWorkspace, "aimark-proof.md"), "utf8"),
  ]);
  assert.match(indexHtml, /name=["']description["']/i);
  assert.match(indexHtml, /id=["']aimark-schema["']/i);
  assert.match(indexHtml, /LocalBusiness/);
  assert.match(indexHtml, /AI Mark Test Clinic/);
  assert.match(proofMd, /AI Mark apply smoke passed/i);
  assert.match(proofMd, /index\.html/i);
  assert.match(proofMd, /aimark-schema/i);

  const progress = cloudRequests.find((r) => r.url === "/api/agent/jobs/progress" && r.body.status === "running");
  assert.ok(progress, `expected running progress callback; got ${JSON.stringify(cloudRequests)}`);
  const cloudResult = cloudRequests.find((r) => r.url === "/api/agent/jobs/result" && r.body.job_id === "job_real_apply_smoke");
  assert.ok(cloudResult, `expected cloud result callback; got ${JSON.stringify(cloudRequests)}`);

  console.log(`local-bridge-real-apply: ok (${health.data.runner_label})`);
} finally {
  stopProcess(bridge);
  await closeServer(cloudServer).catch(() => {});
  await delay(500);
  if (!args.includes("--keep-temp")) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  else console.log(`kept temp dir: ${tempDir}`);
}
