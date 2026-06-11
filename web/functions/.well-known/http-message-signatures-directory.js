/**
 * AI Mark — Web Bot Auth key directory
 * GET /.well-known/http-message-signatures-directory
 * ------------------------------------------------------------------
 * Publishes AIMarkBot's Ed25519 public key(s) as a JWKS so any origin
 * (Cloudflare Verified Bots, custom verifiers) can authenticate our
 * scanner's signed requests. This is the file that makes AIMarkBot one
 * of the first audit bots with cryptographically verified identity.
 *
 * Spec notes implemented here:
 *   - Media type: application/http-message-signatures-directory+json
 *   - Body: { "keys": [ <public JWK with kid/alg/use> ] }
 *   - The response itself carries Signature headers binding our own
 *     authority (directory self-signature), when the key is configured.
 *   - Cacheable for 24h; rotation = serve old + new keys during overlap.
 *
 * Env: BOTAUTH_PUBLIC_JWK (required), optional BOTAUTH_PUBLIC_JWK_PREV
 * for rotation overlap.
 */
import { signDirectoryResponse } from "../api/_botauth.js";

export async function onRequestGet({ request, env }) {
  const keys = [];
  for (const name of ["BOTAUTH_PUBLIC_JWK", "BOTAUTH_PUBLIC_JWK_PREV"]) {
    try {
      if (env[name]) {
        const jwk = JSON.parse(env[name]);
        if (jwk && jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x && !jwk.d) {
          keys.push(jwk);
        }
      }
    } catch { /* skip malformed entries */ }
  }
  if (!keys.length) {
    return new Response(JSON.stringify({ error: "bot identity not configured" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const headers = {
    "content-type": "application/http-message-signatures-directory+json",
    "cache-control": "public, max-age=86400",
    "access-control-allow-origin": "*",
  };
  const sig = await signDirectoryResponse(env, request.url);
  if (sig) Object.assign(headers, sig);
  return new Response(JSON.stringify({ keys }), { status: 200, headers });
}
