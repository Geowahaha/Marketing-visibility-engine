const enc = new TextEncoder();
const dec = new TextDecoder();

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function authSecret(env) {
  return String(env.AUTH_SESSION_SECRET || env.OAUTH_TOKEN_SECRET || env.PAID_EXPORT_SECRET || "").trim();
}

export function base64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function unbase64url(value) {
  const s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
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

export async function signSession(user, secret, ttlSec = 60 * 60 * 24 * 7) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    sid: user.sid || crypto.randomUUID(),
    provider: user.provider || "",
    name: user.name || user.email || user.login || "Signed in user",
    email: String(user.email || "").toLowerCase(),
    avatar: user.avatar || "",
    login: user.login || "",
    iat: now,
    exp: now + ttlSec,
  };
  const payload = base64url(enc.encode(JSON.stringify(body)));
  const sig = await hmacHex(secret, payload);
  return { token: `${payload}.${sig}`, session: body };
}

export async function verifySessionToken(token, secret) {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig || !secret) return null;
    const expected = await hmacHex(secret, payload);
    if (!timingSafeEqual(expected, sig)) return null;
    const session = JSON.parse(dec.decode(unbase64url(payload)));
    if (!session?.sid || Number(session.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export async function requireSession(request, env) {
  const secret = authSecret(env);
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const session = await verifySessionToken(cookies.aimark_session, secret);
  return session;
}

function listEnv(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function signPaidAccessToken(payload = {}, secret, ttlSec = 60 * 60 * 24 * 30) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    typ: "aimark_paid",
    product: String(payload.product || "credits"),
    credits: Math.max(0, Number(payload.credits || 0)),
    source: String(payload.source || "checkout"),
    iat: now,
    exp: now + Math.max(60, Number(ttlSec || 0)),
  };
  const encoded = base64url(enc.encode(JSON.stringify(body)));
  const sig = await hmacHex(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifyPaidAccessToken(token, secret) {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig || !secret) return null;
    const expected = await hmacHex(secret, payload);
    if (!timingSafeEqual(expected, sig)) return null;
    const data = JSON.parse(dec.decode(unbase64url(payload)));
    if (data.typ !== "aimark_paid") return null;
    if (Number(data.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function paidCookieHeader(token, maxAgeSec = 60 * 60 * 24 * 30) {
  return `aimark_paid_export=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.max(60, Number(maxAgeSec || 0))}; Secure; HttpOnly; SameSite=Lax`;
}

async function paidCreditBalance(request, env) {
  if (!env.ENTITLEMENTS_KV) return null;
  const session = await requireSession(request, env);
  const email = String(session?.email || "").toLowerCase();
  if (!email) return null;
  try {
    const credits = (await env.ENTITLEMENTS_KV.get(`credits:email:${email}`, "json")) || {};
    const balance = Math.max(0, Number(credits.balance || 0));
    if (balance <= 0) return null;
    return {
      email,
      balance,
      lifetime_purchased: Math.max(0, Number(credits.lifetime_purchased || 0)),
      last_session_id: credits.last_session_id || "",
      last_product: credits.last_product || "",
      updated_at: credits.updated_at || "",
    };
  } catch {
    return null;
  }
}

export async function paidStatus(request, env, lockedReason = "preview_only") {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const bypassIps = [...listEnv(env.EXPORT_BYPASS_IPS), ...listEnv(env.RATE_LIMIT_BYPASS_IPS)];
  if (ip && bypassIps.includes(ip)) return { paid: true, reason: "tester_ip_bypass" };

  const secret = String(env.PAID_EXPORT_SECRET || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const apiToken = String(env.PAID_EXPORT_API_TOKEN || "").trim();
  if (apiToken && bearer && bearer === apiToken) return { paid: true, reason: "paid_bearer" };

  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies.aimark_paid_export ? decodeURIComponent(cookies.aimark_paid_export) : "";
  const paidToken = await verifyPaidAccessToken(token, secret);
  if (paidToken) return { paid: true, reason: "paid_cookie", token: paidToken };

  const credit = await paidCreditBalance(request, env);
  if (credit) return { paid: true, reason: "credit_balance", credits: credit };

  return { paid: false, reason: lockedReason };
}

export async function paid(request, env) {
  return (await paidStatus(request, env)).paid;
}

async function aesKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(String(value || "")));
  return `${base64url(iv)}.${base64url(ciphertext)}`;
}

export async function decryptSecret(value, secret) {
  const [iv, ciphertext] = String(value || "").split(".");
  if (!iv || !ciphertext) return "";
  const key = await aesKey(secret);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64url(iv) }, key, unbase64url(ciphertext));
  return dec.decode(plain);
}

export function publicUser(session) {
  if (!session) return null;
  return {
    provider: session.provider || "",
    name: session.name || session.email || session.login || "Signed in user",
    email: session.email || "",
    avatar: session.avatar || "",
    login: session.login || "",
  };
}
