/**
 * AI Mark — Web Bot Auth (_botauth.js)
 * ------------------------------------------------------------------
 * Cryptographically verified crawler identity for AIMarkBot, implementing
 * the Web Bot Auth profile of HTTP Message Signatures (RFC 9421) with
 * Ed25519, as verified by Cloudflare Verified Bots and compatible origins.
 *
 * What target sites receive on every audit fetch:
 *   Signature-Agent: "https://aimark.pages.dev"
 *   Signature-Input: sig1=("@authority" "signature-agent");created=...;
 *                    expires=...;keyid="<jwk-thumbprint>";alg="ed25519";
 *                    tag="web-bot-auth"
 *   Signature:       sig1=:<base64 ed25519 signature>:
 *
 * Verifiers resolve Signature-Agent → GET
 * https://aimark.pages.dev/.well-known/http-message-signatures-directory
 * → match keyid → verify. Spoofing AIMarkBot becomes impossible.
 *
 * Env (set in Cloudflare dashboard / wrangler secrets — never in code):
 *   BOTAUTH_PRIVATE_JWK  secret  Ed25519 private JWK (generate-botauth-key.mjs)
 *   BOTAUTH_PUBLIC_JWK   var     matching public JWK (also served by directory)
 *   BOTAUTH_AGENT_URL    var     origin hosting the key directory,
 *                                e.g. "https://aimark.pages.dev"
 *
 * Fail-open by design: if the key is absent or signing throws, signedFetch
 * degrades to a normal fetch — an audit must never fail because of identity.
 */

const enc = new TextEncoder();

const SIG_LABEL = "sig1";
const SIG_TAG = "web-bot-auth";
const SIG_TTL_SEC = 300; // 5 min validity window per Web Bot Auth guidance

let _keyPromise = null;

function b64(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

export function botAuthConfigured(env) {
  return !!(env && env.BOTAUTH_PRIVATE_JWK && env.BOTAUTH_AGENT_URL);
}

async function getSigningKey(env) {
  if (!botAuthConfigured(env)) return null;
  if (!_keyPromise) {
    _keyPromise = (async () => {
      try {
        const { alg, use, key_ops, ...jwk } = JSON.parse(env.BOTAUTH_PRIVATE_JWK);
        const key = await crypto.subtle.importKey(
          "jwk", jwk, { name: "Ed25519" }, false, ["sign"],
        );
        return { key, kid: String(jwk.kid || "") };
      } catch (e) {
        console.error("botauth: key import failed:", String(e).slice(0, 200));
        return null;
      }
    })();
  }
  return _keyPromise;
}

/**
 * Build the RFC 9421 signature base for the Web Bot Auth component set
 * ("@authority" "signature-agent") and the matching parameter string.
 */
function buildSignatureBase({ authority, agentField, created, expires, kid }) {
  const params =
    `("@authority" "signature-agent")` +
    `;created=${created};expires=${expires}` +
    `;keyid="${kid}";alg="ed25519";tag="${SIG_TAG}"`;
  const base =
    `"@authority": ${authority}\n` +
    `"signature-agent": ${agentField}\n` +
    `"@signature-params": ${params}`;
  return { base, params };
}

/**
 * Produce the three Web Bot Auth headers for a request to `url`.
 * Returns null when unconfigured (caller falls back to plain fetch).
 */
export async function botAuthHeaders(env, url) {
  const entry = await getSigningKey(env);
  if (!entry) return null;
  try {
    const authority = new URL(url).host.toLowerCase();
    // Signature-Agent is an RFC 8941 Structured Field string → quoted.
    const agentField = `"${String(env.BOTAUTH_AGENT_URL).replace(/\/+$/, "")}"`;
    const created = Math.floor(Date.now() / 1000);
    const expires = created + SIG_TTL_SEC;
    const { base, params } = buildSignatureBase({
      authority, agentField, created, expires, kid: entry.kid,
    });
    const sig = await crypto.subtle.sign("Ed25519", entry.key, enc.encode(base));
    return {
      "Signature-Agent": agentField,
      "Signature-Input": `${SIG_LABEL}=${params}`,
      "Signature": `${SIG_LABEL}=:${b64(sig)}:`,
    };
  } catch (e) {
    console.error("botauth: signing failed:", String(e).slice(0, 200));
    return null;
  }
}

/**
 * Drop-in replacement for fetch() in audit code paths.
 *   const r = await signedFetch(env, target, { headers: { "User-Agent": UA } });
 * Adds Web Bot Auth headers when configured; otherwise behaves exactly
 * like fetch. Existing caller headers are preserved (signature headers
 * never collide with them).
 */
export async function signedFetch(env, url, init = {}) {
  const sigHeaders = await botAuthHeaders(env, url);
  if (!sigHeaders) return fetch(url, init);
  const headers = new Headers(init.headers || {});
  for (const [k, v] of Object.entries(sigHeaders)) headers.set(k, v);
  return fetch(url, { ...init, headers });
}

/**
 * Sign a RESPONSE we serve (used by the key directory itself, which the
 * Web Bot Auth spec expects to carry a directory signature binding our
 * own authority). Same base shape, tag remains "web-bot-auth" with the
 * directory media type carrying the semantics.
 */
export async function signDirectoryResponse(env, requestUrl) {
  return botAuthHeaders(env, requestUrl);
}
