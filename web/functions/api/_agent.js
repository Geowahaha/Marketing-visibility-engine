import { authSecret, base64url, json, publicUser, unbase64url } from "./_auth.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_TTL_SEC = 10 * 60;
const AGENT_TTL_SEC = 60 * 60 * 24 * 90;

export function agentKv(env) {
  if (env.AGENT_DB) return d1Kv(env.AGENT_DB);
  return env.AGENT_KV || env.ENTITLEMENTS_KV || null;
}

function d1Kv(db) {
  const ensure = async () => {
    await db.prepare(
      "CREATE TABLE IF NOT EXISTS agent_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL)",
    ).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_store_expires ON agent_store(expires_at)").run();
  };
  return {
    async get(key, type = "text") {
      await ensure();
      const now = Math.floor(Date.now() / 1000);
      const row = await db.prepare(
        "SELECT value FROM agent_store WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
      ).bind(String(key), now).first();
      if (!row) {
        await db.prepare("DELETE FROM agent_store WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?").bind(String(key), now).run();
        return null;
      }
      if (type === "json") {
        try { return JSON.parse(row.value); } catch { return null; }
      }
      return row.value;
    },
    async put(key, value, options = {}) {
      await ensure();
      const now = Math.floor(Date.now() / 1000);
      const ttl = Number(options.expirationTtl || options.expiration_ttl || 0);
      const expiresAt = ttl > 0 ? now + Math.max(1, Math.floor(ttl)) : null;
      await db.prepare(
        "INSERT OR REPLACE INTO agent_store (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(String(key), String(value), expiresAt, now).run();
    },
    async delete(key) {
      await ensure();
      await db.prepare("DELETE FROM agent_store WHERE key = ?").bind(String(key)).run();
    },
  };
}

export function originFrom(request, env) {
  return String(env.PUBLIC_BASE_URL || new URL(request.url).origin || "https://aimark.pages.dev").replace(/\/+$/, "");
}

export function normalizeUserCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function formatUserCode(value) {
  const raw = normalizeUserCode(value);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

function randomString(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}

function randomUserCode() {
  const data = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of data) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export async function createUniqueUserCode(kv) {
  for (let i = 0; i < 12; i++) {
    const code = randomUserCode();
    const existing = await kv.get(pairCodeKey(code));
    if (!existing) return code;
  }
  throw new Error("Could not allocate agent pair code.");
}

export function pairCodeKey(code) {
  return `agent_pair:code:${normalizeUserCode(code)}`;
}

export function pairDeviceKey(deviceCode) {
  return `agent_pair:device:${String(deviceCode || "").trim()}`;
}

export function agentKey(agentId) {
  return `agent:${agentId}`;
}

export function agentUserKey(sid) {
  return `agent_user:${sid}`;
}

export function agentQueueKey(agentId) {
  return `agent_queue:${agentId}`;
}

export function publicAgent(agent = {}) {
  if (!agent) return null;
  return {
    agent_id: agent.agent_id || "",
    device_name: agent.device_name || "AI Mark bridge",
    mode: "cloud",
    paired_at: agent.paired_at || "",
    last_seen: agent.last_seen || "",
    inbox: agent.inbox || "",
  };
}

export async function makePairRecord(request, env, deviceName = "") {
  const kv = agentKv(env);
  if (!kv) throw new Error("Agent KV is not configured.");
  const origin = originFrom(request, env);
  const rawCode = await createUniqueUserCode(kv);
  const userCode = formatUserCode(rawCode);
  const deviceCode = randomString(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIR_TTL_SEC * 1000);
  const verificationUri = `${origin}/agent-pair.html`;
  const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(userCode)}&one_click=1`;
  const record = {
    status: "pending",
    raw_code: rawCode,
    user_code: userCode,
    device_code: deviceCode,
    device_name: String(deviceName || "AI Mark bridge").slice(0, 90),
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    origin,
  };
  await kv.put(pairDeviceKey(deviceCode), JSON.stringify(record), { expirationTtl: PAIR_TTL_SEC });
  await kv.put(pairCodeKey(rawCode), deviceCode, { expirationTtl: PAIR_TTL_SEC });
  return record;
}

export function pairTtl(record) {
  const remaining = Math.floor((new Date(record.expires_at).getTime() - Date.now()) / 1000);
  return Math.max(30, Math.min(PAIR_TTL_SEC, remaining || 30));
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signAgentToken(agent, env, ttlSec = AGENT_TTL_SEC) {
  const secret = authSecret(env);
  if (!secret) throw new Error("AUTH_SESSION_SECRET or PAID_EXPORT_SECRET is required for agent tokens.");
  const now = Math.floor(Date.now() / 1000);
  const body = {
    typ: "aimark_agent",
    agent_id: agent.agent_id,
    sid: agent.sid,
    email: agent.email || "",
    device_name: agent.device_name || "AI Mark bridge",
    iat: now,
    exp: now + ttlSec,
  };
  const payload = base64url(enc.encode(JSON.stringify(body)));
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyAgentToken(token, env) {
  try {
    const secret = authSecret(env);
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig || !secret) return null;
    const expected = await hmacHex(secret, payload);
    if (!timingSafeEqual(expected, sig)) return null;
    const data = JSON.parse(dec.decode(unbase64url(payload)));
    if (data.typ !== "aimark_agent") return null;
    if (!data.agent_id || !data.sid || Number(data.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function requireAgent(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const agent = await verifyAgentToken(token, env);
  if (!agent) return { response: json({ error: "agent_auth_required" }, 401), agent: null };
  return { response: null, agent };
}

export async function readQueue(kv, agentId) {
  return (await kv.get(agentQueueKey(agentId), "json")) || [];
}

export async function writeQueue(kv, agentId, queue) {
  await kv.put(agentQueueKey(agentId), JSON.stringify(queue.slice(0, 50)), { expirationTtl: 60 * 60 * 24 * 7 });
}

export function sessionAgentRecord(session, agentId, deviceName, extra = {}) {
  const user = publicUser(session);
  const now = new Date().toISOString();
  return {
    agent_id: agentId,
    sid: session.sid,
    email: user?.email || session.email || "",
    user,
    device_name: String(deviceName || "AI Mark bridge").slice(0, 90),
    mode: "cloud",
    paired_at: extra.paired_at || now,
    last_seen: extra.last_seen || now,
    inbox: extra.inbox || "",
  };
}
