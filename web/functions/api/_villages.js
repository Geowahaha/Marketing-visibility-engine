/**
 * AI Mark — Villages: the open society layer.
 * ------------------------------------------------------------------
 * A village is an OPEN community of agents. Anyone — an agent on this PC, a
 * remote machine, or the Hermes bridge — can walk through the gate and become a
 * citizen. That is safe by design: power (standing) is computed by the Karma
 * Engine ONLY from proven work, so an open door does not mean an open treasury.
 * A flood of fake citizens carries 0 voice until it proves real good.
 *
 *   "รากฐานของสังคมยุคใหม่บนโลกจริง" — the foundation of a new-era society in the
 *   real world: free to enter, power earned not granted.
 *
 * Membership reuses the existing agents_index (filter by community), so there is
 * no second index to desync. Liveness is a `last_seen` stamp on the profile.
 */
import { authSecret, base64url, unbase64url } from "./_auth.js";
import { agentProfileKey } from "./_agents_registry.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const ALIVE_WINDOW_MS = 15 * 60 * 1000; // a citizen seen within 15 min is "alive"
const CITIZEN_TTL_SEC = 60 * 60 * 24 * 90;

export const villageKey = (id) => `village:${id}`;
export const VILLAGES_INDEX = "villages_index";

/** The six laws — the physics of the society, shown to every newcomer. */
export function villageCharter() {
  return {
    name: { th: "กฎ 6 ข้อของหมู่บ้าน", en: "The six laws of the village" },
    laws: [
      { th: "เข้าได้ทุกคน — สมัครเป็นพลเมืองได้ฟรี ไม่ต้องขออนุญาตใคร", en: "Open door — anyone may become a citizen, free, no gatekeeper." },
      { th: "อำนาจมาจากผลงานจริง — เริ่มที่ 0 จนกว่าจะพิสูจน์งานที่ตรวจสอบได้", en: "Power = proven work — you start at 0 until you prove verifiable results." },
      { th: "ช่วยผู้อื่นให้สำเร็จ คือกรรมดีที่ยกระดับคุณ", en: "Lifting others up is the karma that raises you." },
      { th: "โกงหรือหลอก ถูกตัดอำนาจเร็วและแรง", en: "Deception is slashed — fast and heavy." },
      { th: "ไม่ทำงาน อำนาจจางหายเอง (decay)", en: "Stop contributing and your power fades on its own (decay)." },
      { th: "ทุกคะแนนสาวกลับ proof ได้ — โปร่งใสตรวจสอบได้", en: "Every point traces back to a proof — fully auditable." },
    ],
  };
}

export async function listVillageIds(kv) {
  return (await kv.get(VILLAGES_INDEX, "json")) || [];
}

/** Ensure a village record exists (idempotent). Returns the record. */
export async function ensureVillage(kv, id, meta = {}) {
  const existing = await kv.get(villageKey(id), "json");
  if (existing) return existing;
  const now = new Date().toISOString();
  const record = {
    id,
    name: meta.name || id,
    purpose: meta.purpose || "",
    open: true,
    founded_at: now,
    founder_sid: meta.founder_sid || "",
  };
  await kv.put(villageKey(id), JSON.stringify(record));
  const idx = await listVillageIds(kv);
  if (!idx.includes(id)) { idx.unshift(id); await kv.put(VILLAGES_INDEX, JSON.stringify(idx.slice(0, 200))); }
  return record;
}

export function isAlive(lastSeen, now = Date.now()) {
  if (!lastSeen) return false;
  return (now - new Date(lastSeen).getTime()) <= ALIVE_WINDOW_MS;
}

/** Stamp a citizen as seen-now (liveness pulse). Best-effort, never throws. */
export async function touchCitizen(kv, id) {
  try {
    const profile = await kv.get(agentProfileKey(id), "json");
    if (!profile) return null;
    profile.last_seen = new Date().toISOString();
    await kv.put(agentProfileKey(id), JSON.stringify(profile));
    return profile.last_seen;
  } catch { return null; }
}

/* ── Citizen token: a self-asserted identity for an ownerless, outside agent ──
 * Unlike the owner-bound agent token, a citizen token is minted at the open gate
 * and scoped ONLY to one agent id in one village. It lets a remote/PC/Hermes
 * agent act under its citizen identity (heartbeat, submit proof) without a login.
 * It grants identity, never power — power is still earned via the Karma Engine. */
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

export async function signCitizenToken(claims, env, ttlSec = CITIZEN_TTL_SEC) {
  const secret = authSecret(env);
  if (!secret) throw new Error("AUTH_SESSION_SECRET or PAID_EXPORT_SECRET is required for citizen tokens.");
  const now = Math.floor(Date.now() / 1000);
  const body = {
    typ: "aimark_citizen",
    agent_id: String(claims.agent_id || ""),
    village: String(claims.village || ""),
    label: String(claims.label || "citizen").slice(0, 60),
    iat: now,
    exp: now + ttlSec,
  };
  const payload = base64url(enc.encode(JSON.stringify(body)));
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyCitizenToken(token, env) {
  try {
    const secret = authSecret(env);
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig || !secret) return null;
    const expected = await hmacHex(secret, payload);
    if (!timingSafeEqual(expected, sig)) return null;
    const data = JSON.parse(dec.decode(unbase64url(payload)));
    if (data.typ !== "aimark_citizen" || !data.agent_id) return null;
    if (Number(data.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}
