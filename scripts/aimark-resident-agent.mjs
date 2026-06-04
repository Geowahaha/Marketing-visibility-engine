#!/usr/bin/env node
/**
 * AI Mark — Resident Agent runner
 * ------------------------------------------------------------------
 * Makes an AI "sit in" a Live Agent Session and respond continuously: poll the
 * room → on a new message it should answer → run the local AI CLI (Claude/Codex/
 * etc.) to draft a reply → post it back. This is the piece that turns the relay
 * from "messages you shuttle by hand" into a room where AIs work as a team.
 *
 *   node scripts/aimark-resident-agent.mjs \
 *     --session sess_xxx --token <session_token> \
 *     --name Opus --runner claude --runner-cmd claude \
 *     [--base https://aimark.pages.dev] [--respond-to owner|all] [--poll-ms 2000]
 *     [--dry-run]   # read + build the prompt, but DON'T spawn a runner or post
 *
 * Security: it acts only inside ONE session with the capabilities baked into the
 * session token. The relay carries messages; real side effects still go through
 * gated AI Mark tools. Loop-safe: never answers its own messages; by default
 * only answers the owner.
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, def = "") => {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : def;
};
const flag = (name) => args.includes(name);

const BASE = (arg("--base", process.env.AIMARK_CLOUD_BASE || "https://aimark.pages.dev")).replace(/\/+$/, "");
const SESSION = arg("--session", process.env.AIMARK_SESSION_ID);
const TOKEN = arg("--token", process.env.AIMARK_SESSION_TOKEN);
const NAME = arg("--name", "Resident");
const RUNNER = arg("--runner", "claude").toLowerCase();
const RUNNER_CMD = arg("--runner-cmd", RUNNER === "codex" ? "codex" : "claude");
const RESPOND_TO = arg("--respond-to", "owner").toLowerCase(); // owner | all
const POLL_MS = Math.max(1000, Number(arg("--poll-ms", "2000")) || 2000);
const DRY = flag("--dry-run");
const CATCHUP = flag("--catch-up"); // answer the existing backlog too (default: only new messages)
const MENTION_ONLY = flag("--mention-only"); // for secondary agents: speak only when @mentioned
const MAX_REPLIES = Math.max(1, Number(arg("--max-replies", "40")) || 40); // budget cap: stop after N replies
const COOLDOWN_MS = Math.max(0, Number(arg("--cooldown-ms", "8000")) || 0);  // min gap between replies (rate limit)

if (!SESSION || !TOKEN) {
  console.error("Required: --session <id> --token <session_token>");
  process.exit(1);
}

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let cursor = 0;
let selfLabel = "";
let replyCount = 0;
let budgetNotified = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readNew() {
  const r = await fetch(`${BASE}/api/agent/session/${SESSION}/message?since=${cursor}`, { headers });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.you && j.you.label) selfLabel = j.you.label;
  if (Array.isArray(j.messages) && j.messages.length) cursor = j.cursor;
  return j;
}

async function postReply(text) {
  await fetch(`${BASE}/api/agent/session/${SESSION}/message`, {
    method: "POST", headers, body: JSON.stringify({ type: "chat", text }),
  });
}

function buildPrompt(history, latest) {
  const convo = history.slice(-10).map((m) => `${m.sender.label} (${m.sender.role}): ${m.text || m.tool || ""}`).join("\n");
  return [
    `You are "${NAME}", a resident AI agent inside an AI Mark live work session.`,
    `Answer the latest message helpfully and concisely, in the SAME language the user wrote (Thai if they wrote Thai).`,
    `If a website/SEO/visibility task is implied, say exactly which AI Mark capability you would use (scan / citation-probe / content / deploy) and the next step.`,
    `Do not roleplay other participants. Output ONLY your reply text, no preamble.`,
    ``,
    `Recent conversation:`,
    convo,
    ``,
    `Latest message from ${latest.sender.label}: ${latest.text || ""}`,
  ].join("\n");
}

function runLocalRunner(prompt) {
  return new Promise((resolve) => {
    // Prompt goes via STDIN, never argv → no shell-injection / quoting issues.
    // shell:true on Windows so npm .cmd shims (claude/codex) resolve (Node 22 won't
    // spawn a .cmd without it). RUNNER_CMD is whitelisted by the bridge.
    const cmdArgs = RUNNER === "codex" ? ["exec"] : ["-p", "--output-format", "text"];
    const child = spawn(RUNNER_CMD, cmdArgs, { windowsHide: true, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const to = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, text: "", detail: "runner_timeout" }); }, 120000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(to); resolve({ ok: false, text: "", detail: String(e) }); });
    child.on("close", (code) => { clearTimeout(to); resolve({ ok: code === 0, text: out.trim(), detail: err.slice(0, 200) }); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* ignore */ }
  });
}

function hasAnyMention(text) { return /@[\w฀-๿-]+/.test(text || ""); }
function mentionsMe(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("@all") || t.includes("@everyone")) return true;
  const myNames = [NAME.toLowerCase(), (selfLabel || "").toLowerCase()].filter(Boolean);
  return myNames.some((n) => n && t.includes("@" + n));
}

/**
 * Turn-taking rules (loop-safe team room):
 *  - never answer my own messages
 *  - answer ONLY the human owner (never another agent) → no agent↔agent loops
 *  - if the owner @mentions someone, only the mentioned agent answers
 *  - --mention-only (secondary agents): speak ONLY when @mentioned
 */
function shouldAnswer(m) {
  if (!m || !m.sender) return false;
  if (m.sender.label === selfLabel) return false;
  if (m.sender.role !== "owner") return false;
  if (!["chat", "plan", "tool_request", "approval_request"].includes(m.type)) return false;
  const mentioned = hasAnyMention(m.text);
  if (mentioned) return mentionsMe(m.text);
  if (MENTION_ONLY) return false;            // un-mentioned + secondary agent → stay quiet
  return RESPOND_TO === "owner" || RESPOND_TO === "all";
}

async function tick() {
  const j = await readNew();
  if (!j) return;
  const all = j.messages || [];
  for (const m of all) {
    if (!shouldAnswer(m)) continue;
    const prompt = buildPrompt(all, m);
    if (DRY) {
      console.log(`\n[dry-run] would answer #${m.seq} from ${m.sender.label}:`);
      console.log(`  runner: ${RUNNER_CMD} (${RUNNER})`);
      console.log(`  prompt (first 300):\n${prompt.slice(0, 300)}`);
      continue;
    }
    if (replyCount >= MAX_REPLIES) {
      if (!budgetNotified) { budgetNotified = true; console.log(`Budget reached (${MAX_REPLIES} replies) — going quiet. Raise --max-replies to continue.`); try { await postReply(`(${NAME} ถึงงบจำกัด ${MAX_REPLIES} ข้อความแล้ว — หยุดพักเพื่อคุมค่าใช้จ่าย)`); } catch { /* ignore */ } }
      return;
    }
    console.log(`Answering #${m.seq} from ${m.sender.label} as ${NAME}… (${replyCount + 1}/${MAX_REPLIES})`);
    const res = await runLocalRunner(prompt);
    if (res.ok && res.text) { await postReply(res.text.slice(0, 4000)); replyCount++; console.log(`  ✓ replied (${res.text.length} chars)`); if (COOLDOWN_MS) await sleep(COOLDOWN_MS); }
    else { console.log(`  ✗ runner failed: ${res.detail}`); }
  }
}

console.log(`AI Mark resident agent "${NAME}" joining ${SESSION} via ${BASE} (runner=${RUNNER_CMD}, respond-to=${RESPOND_TO}${DRY ? ", DRY-RUN" : ""})`);
if (DRY) {
  await tick();
  console.log("\n[dry-run] done — no runner spawned, nothing posted.");
  process.exit(0);
}
if (!CATCHUP) { await readNew(); console.log(`Primed at cursor ${cursor} — answering only NEW messages (use --catch-up to answer backlog).`); }
await tick();
setInterval(() => { tick().catch((e) => console.error("tick error:", String(e))); }, POLL_MS);
