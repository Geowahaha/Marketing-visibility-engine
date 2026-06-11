#!/usr/bin/env node
/**
 * AI Mark — Web Bot Auth key generator
 * ------------------------------------------------------------------
 * Generates the Ed25519 identity for AIMarkBot (RFC 9421 HTTP Message
 * Signatures, Web Bot Auth profile) and prints:
 *
 *   1. BOTAUTH_PRIVATE_JWK  -> set as an encrypted Cloudflare secret:
 *        npx wrangler pages secret put BOTAUTH_PRIVATE_JWK --project-name aimark
 *   2. BOTAUTH_PUBLIC_JWK   -> set as a plain env var (it is public):
 *        (Dashboard → aimark → Settings → Variables) or secret, either works
 *   3. kid (RFC 7638 JWK thumbprint) — embedded in both JWKs.
 *
 * Run:  node scripts/generate-botauth-key.mjs
 * NEVER commit the private JWK. Rotate by generating a new pair and
 * keeping BOTH public keys in the directory during the overlap window.
 */
import { generateKeyPairSync, createHash } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });   // { kty:'OKP', crv:'Ed25519', x }
const priv = privateKey.export({ format: "jwk" }); // adds d

// RFC 7638 thumbprint: SHA-256 over the canonical JSON of required members,
// lexicographic order: crv, kty, x  (for OKP keys).
const canonical = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x });
const kid = createHash("sha256").update(canonical).digest("base64url");

const publicJwk  = { ...pub,  kid, alg: "EdDSA", use: "sig" };
const privateJwk = { ...priv, kid, alg: "EdDSA", use: "sig" };

console.log("=== AIMarkBot Web Bot Auth identity ===\n");
console.log("kid (key thumbprint):", kid, "\n");
console.log("BOTAUTH_PUBLIC_JWK (publishable):");
console.log(JSON.stringify(publicJwk), "\n");
console.log("BOTAUTH_PRIVATE_JWK (SECRET — wrangler pages secret put BOTAUTH_PRIVATE_JWK):");
console.log(JSON.stringify(privateJwk), "\n");
console.log("Next steps:");
console.log("  1. npx wrangler pages secret put BOTAUTH_PRIVATE_JWK --project-name aimark   (paste private JWK)");
console.log("  2. Set BOTAUTH_PUBLIC_JWK env var to the public JWK JSON.");
console.log("  3. Set BOTAUTH_AGENT_URL env var, e.g. https://aimark.pages.dev");
console.log("  4. Deploy. Verify: curl -s https://aimark.pages.dev/.well-known/http-message-signatures-directory");
