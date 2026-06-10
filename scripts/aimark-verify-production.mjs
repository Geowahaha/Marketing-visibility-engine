#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const webRoot = path.join(repoRoot, "web");
const productionBase = process.env.AIMARK_PRODUCTION_BASE || "https://aimark.pages.dev";
const args = new Set(process.argv.slice(2));
const skipProduction = args.has("--skip-production");

function rel(...parts) {
  return path.join(repoRoot, ...parts);
}

function run(command, commandArgs = [], options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const isWindowsNpm = process.platform === "win32" && command === "npm";
    const cmdQuote = (value) => {
      const s = String(value);
      return /^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
    };
    const executable = isWindowsNpm ? "cmd.exe" : command;
    const finalArgs = isWindowsNpm
      ? ["/d", "/s", "/c", ["npm", ...commandArgs].map(cmdQuote).join(" ")]
      : commandArgs;
    let child;
    try {
      child = spawn(executable, finalArgs, {
        cwd: options.cwd || repoRoot,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(options.env || {}) },
      });
    } catch (error) {
      resolve({ ok: false, command: executable, args: finalArgs, code: null, stdout: "", stderr: "", error: String(error.message || error), ms: Date.now() - started });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      resolve({ ok: false, command: executable, args: commandArgs, code: null, stdout, stderr, error: String(error.message || error), ms: Date.now() - started });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, command: executable, args: commandArgs, code, stdout, stderr, error: "", ms: Date.now() - started });
    });
  });
}

function compact(text, limit = 2500) {
  const s = String(text || "").trim();
  if (s.length <= limit) return s;
  return `${s.slice(0, 1200)}\n...\n${s.slice(-1200)}`;
}

function printStep(name, result) {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${name} (${result.ms}ms)`);
  if (!result.ok) {
    const detail = compact(`${result.stdout}\n${result.stderr}\n${result.error}`);
    if (detail) console.log(detail);
  }
}

function verifyIndexScripts() {
  const started = Date.now();
  try {
    const html = fs.readFileSync(rel("web", "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    scripts.forEach((script, index) => new vm.Script(script, { filename: `web/index.html<script ${index}>` }));
    return { ok: true, code: 0, stdout: `index scripts syntax ok: ${scripts.length}`, stderr: "", error: "", ms: Date.now() - started };
  } catch (error) {
    return { ok: false, code: null, stdout: "", stderr: "", error: String(error.stack || error), ms: Date.now() - started };
  }
}

async function productionSmoke() {
  const started = Date.now();
  try {
    const [homeRes, bridgeRes, healthRes, scanRes] = await Promise.all([
      fetch(`${productionBase}/`),
      fetch(`${productionBase}/downloads/aimark-local-bridge.mjs`),
      fetch(`${productionBase}/api/system-health`),
      fetch(`${productionBase}/api/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${productionBase}/proof-demo.html`, lang: "th", deterministic_only: true }),
      }),
    ]);
    const home = await homeRes.text();
    const bridge = await bridgeRes.text();
    const health = await healthRes.json();
    const scan = await scanRes.json();
    const checks = {
      home_200: homeRes.status === 200,
      has_main_runner_mode: home.includes("mainRunnerMode"),
      has_main_runner_model: home.includes("mainRunnerModel"),
      has_full_access_copy: home.includes("Full access"),
      bridge_200: bridgeRes.status === 200,
      bridge_has_browser_action: bridge.includes("/aimark/browser-action"),
      bridge_has_observe: bridge.includes("observe"),
      health_200: healthRes.status === 200,
      core_live_ready: health.production?.core_live_ready === true,
      runbook_present: !!health.runbook,
      runbook_has_verify_command: !!health.runbook?.verification_commands?.some((x) => /verify:production/.test(x.command || "")),
      performance_lite_health: !!health.groups?.find((g) => g.id === "proof")?.items?.find((x) => x.id === "performance_lite")?.ready,
      scan_200: scanRes.status === 200,
      scan_has_performance_lite: !!scan._performance_lite?.available,
      scan_score_guarded: scan._performance_verified === true || scan._score_status === "provisional",
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    return {
      ok: failed.length === 0,
      code: failed.length ? 1 : 0,
      stdout: JSON.stringify({
        production_base: productionBase,
        checks,
        production_status: health.production?.status,
        optional_missing_lanes: health.production?.optional_missing_lanes || [],
        scan_score_status: scan._score_status,
        performance_verified: scan._performance_verified,
      }, null, 2),
      stderr: failed.length ? `Failed smoke checks: ${failed.join(", ")}` : "",
      error: "",
      ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, code: null, stdout: "", stderr: "", error: String(error.stack || error), ms: Date.now() - started };
  }
}

const steps = [
  ["syntax: scan.js", () => run(process.execPath, ["--check", rel("web", "functions", "api", "scan.js")])],
  ["syntax: system-health.js", () => run(process.execPath, ["--check", rel("web", "functions", "api", "system-health.js")])],
  ["syntax: local bridge", () => run(process.execPath, ["--check", rel("scripts", "aimark-local-bridge.mjs")])],
  ["syntax: downloadable bridge", () => run(process.execPath, ["--check", rel("web", "downloads", "aimark-local-bridge.mjs")])],
  ["syntax: index.html scripts", () => verifyIndexScripts()],
  ["api smoke", () => run("npm", ["run", "test:api"], { cwd: webRoot })],
  ["bridge e2e", () => run("npm", ["run", "test:bridge"], { cwd: webRoot })],
  ["python audits", () => run("python", ["-m", "pytest", "-q"], { cwd: repoRoot })],
  ["npm audit high", () => run("npm", ["audit", "--audit-level=high"], { cwd: webRoot })],
  ["syntax: _botauth.js", () => run(process.execPath, ["--check", rel("web", "functions", "api", "_botauth.js")])],
  ["syntax: deep-scan.js", () => run(process.execPath, ["--check", rel("web", "functions", "api", "deep-scan.js")])],
  ["syntax: bot-access.js", () => run(process.execPath, ["--check", rel("web", "functions", "api", "bot-access.js")])],
  ["botauth e2e", () => run(process.execPath, [rel("scripts", "test-botauth.mjs")])],
];

if (!skipProduction) {
  steps.push(["production smoke", () => productionSmoke()]);
}

console.log(`AI Mark verification runner\nrepo: ${repoRoot}\nproduction: ${skipProduction ? "skipped" : productionBase}\n`);

const results = [];
for (const [name, fn] of steps) {
  const result = await fn();
  printStep(name, result);
  results.push({ name, ...result });
}

const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`\nVerification failed: ${failed.map((x) => x.name).join(", ")}`);
  process.exit(1);
}

console.log("\nVerification passed.");
