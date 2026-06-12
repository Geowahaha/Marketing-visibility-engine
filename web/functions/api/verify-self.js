/**
 * AIBotAuth — verify-self endpoint
 * GET /api/verify-self
 * ------------------------------------------------------------------
 * Signs a server-generated challenge string with our Ed25519 private key
 * so the browser can verify it against the public key in our published
 * key directory, proving we hold the matching private key.
 *
 * Response: { message, signature_b64, keyid, created }
 *
 * SECURITY INVARIANTS:
 *   - Only the fixed format "aibotauth-verify:<unix_timestamp>" is ever
 *     signed. No user-supplied input reaches the signing function.
 *   - This is NOT an HTTP-message-signature. signedFetch and the directory
 *     self-signature are untouched.
 *   - Rate-limited ~30/min/IP via RATE_LIMIT_KV (fail-open if unbound).
 *
 * Env: BOTAUTH_PRIVATE_JWK (secret), BOTAUTH_PUBLIC_JWK (var)
 */

const RATE_LIMIT_MAX = 30;
const RATE_WINDOW_SEC = 60;

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64std(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV || !ip || ip === "unknown") {
    return { allowed: true };
  }
  const key = `rl:verify-self:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    let rec = raw ? JSON.parse(raw) : null;
    if (!rec || now >= rec.resetAt) {
      rec = { count: 0, resetAt: now + RATE_WINDOW_SEC };
    }
    if (rec.count >= RATE_LIMIT_MAX) {
      return { allowed: false, resetIn: rec.resetAt - now };
    }
    rec.count += 1;
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(rec), {
      expirationTtl: rec.resetAt - now,
    });
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

async function getSigningKey(env) {
  if (!env.BOTAUTH_PRIVATE_JWK) return null;
  try {
    // workerd rule: strip alg/use/key_ops before importKey
    const { alg, use, key_ops, ...jwk } = JSON.parse(env.BOTAUTH_PRIVATE_JWK);
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return { key, kid: String(jwk.kid || "") };
  } catch (e) {
    console.error("verify-self: key import failed:", String(e).slice(0, 200));
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  // CORS — browser fetches this from verify.html on same origin; open for dev
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };

  const ip = getClientIp(request);
  const rl = await checkRateLimit(env, ip);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: "rate_limited", retry_after: rl.resetIn }),
      { status: 429, headers: corsHeaders },
    );
  }

  const entry = await getSigningKey(env);
  if (!entry) {
    return new Response(
      JSON.stringify({ error: "signing_key_not_configured" }),
      { status: 503, headers: corsHeaders },
    );
  }

  // Fixed-format challenge — NEVER sign user-supplied input
  const created = Math.floor(Date.now() / 1000);
  const message = `aibotauth-verify:${created}`;

  const sigBytes = await crypto.subtle.sign(
    "Ed25519",
    entry.key,
    new TextEncoder().encode(message),
  );

  return new Response(
    JSON.stringify({
      message,
      signature_b64: b64std(sigBytes),
      keyid: entry.kid,
      created,
    }),
    { status: 200, headers: corsHeaders },
  );
}
