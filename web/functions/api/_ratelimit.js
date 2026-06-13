/**
 * Shared rate-limit helper for LLM endpoints.
 * Fail-CLOSED: if RATE_LIMIT_KV is unbound or errors, DENY the request.
 * Never spend API tokens on an ungated request.
 */

const WINDOW_SEC = 60;

export async function checkRateLimit(env, ip, { max, endpoint }) {
  const bypassIps = String(env.RATE_LIMIT_BYPASS_IPS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (ip && bypassIps.includes(ip)) return { allowed: true, bypassed: true };

  // Fail-CLOSED: no KV binding = deny, not allow
  if (!env.RATE_LIMIT_KV) return { allowed: false, enforced: false, reason: "kv_unbound", resetIn: 60 };
  if (!ip) return { allowed: false, enforced: false, reason: "no_ip", resetIn: 60 };

  const key = `rl:${endpoint}:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    let rec = raw ? JSON.parse(raw) : null;
    if (!rec || now >= rec.resetAt) rec = { count: 0, resetAt: now + WINDOW_SEC };
    if (rec.count >= max) return { allowed: false, resetIn: rec.resetAt - now };
    rec.count += 1;
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(rec), { expirationTtl: rec.resetAt - now });
    return { allowed: true };
  } catch {
    // KV read/write error — fail closed for paid LLM endpoints
    return { allowed: false, reason: "kv_error", resetIn: 60 };
  }
}

export function rl429(resetIn = 60) {
  return new Response(
    JSON.stringify({ error: "rate_limited", retry_after: resetIn, message: `Too many requests — retry in ${resetIn}s.` }),
    { status: 429, headers: { "content-type": "application/json; charset=utf-8", "Retry-After": String(resetIn) } },
  );
}
