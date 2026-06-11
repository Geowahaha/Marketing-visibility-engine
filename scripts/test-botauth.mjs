#!/usr/bin/env node
/**
 * AI Mark — Web Bot Auth end-to-end test (no network needed)
 * ------------------------------------------------------------------
 * Tests both signature profiles:
 *   A. REQUEST signature  tag="web-bot-auth"           component: ("@authority" "signature-agent")
 *   B. DIRECTORY signature tag="http-message-signatures-directory"
 *                          component: ("@authority";req "signature-agent") + nonce
 *
 * Run:  node scripts/test-botauth.mjs
 * Exit 0 = all assertions pass; non-zero = a verifier would reject us.
 */
import { webcrypto as crypto } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert";

const enc = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString("base64");

// ---------- 1. Generate identity (mirror of generate-botauth-key.mjs) ----------
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const kid = createHash("sha256")
  .update(JSON.stringify({ crv: pubJwk.crv, kty: pubJwk.kty, x: pubJwk.x }))
  .digest("base64url");

const verifyKey = await crypto.subtle.importKey(
  "jwk", { ...pubJwk, kid }, { name: "Ed25519" }, false, ["verify"],
);
const agentUrl = "https://aibotauth.com";
const agentField = `"${agentUrl}"`;

// ============================================================
// PART A — REQUEST signature (outgoing audit fetch)
// ============================================================
{
  const target = "https://www.successcasting.com/robots.txt";
  const authority = new URL(target).host.toLowerCase();
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 300;
  const params = `("@authority" "signature-agent");created=${created};expires=${expires};keyid="${kid}";alg="ed25519";tag="web-bot-auth"`;
  const base = `"@authority": ${authority}\n"signature-agent": ${agentField}\n"@signature-params": ${params}`;
  const sigBytes = await crypto.subtle.sign("Ed25519", pair.privateKey, enc.encode(base));

  const sentHeaders = {
    "signature-agent": agentField,
    "signature-input": `sig1=${params}`,
    "signature": `sig1=:${b64(sigBytes)}:`,
  };

  // Parse Signature-Input
  const m = sentHeaders["signature-input"].match(/^sig1=\((.*?)\);(.*)$/);
  assert(m, "[A] Signature-Input must parse");
  const components = m[1].split(" ").map((s) => s.replace(/"/g, ""));
  const p = Object.fromEntries(
    m[2].split(";").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1).replace(/^"|"$/g, "")];
    }),
  );

  assert.deepEqual(components, ["@authority", "signature-agent"], "[A] covered components");
  assert.equal(p.tag, "web-bot-auth", "[A] tag");
  assert.equal(p.alg, "ed25519", "[A] alg");
  assert.equal(p.keyid, kid, "[A] keyid matches directory");
  const now = Math.floor(Date.now() / 1000);
  assert(Number(p.created) <= now && now <= Number(p.expires), "[A] within validity window");

  // Rebuild base and verify
  const rebuiltParams = `("@authority" "signature-agent");created=${p.created};expires=${p.expires};keyid="${p.keyid}";alg="ed25519";tag="${p.tag}"`;
  const rebuiltBase = `"@authority": ${authority}\n"signature-agent": ${agentField}\n"@signature-params": ${rebuiltParams}`;
  assert.equal(rebuiltBase, base, "[A] verifier reconstructs identical base");

  const sigB64 = sentHeaders["signature"].match(/^sig1=:(.+):$/)[1];
  const ok = await crypto.subtle.verify("Ed25519", verifyKey, Buffer.from(sigB64, "base64"), enc.encode(rebuiltBase));
  assert(ok, "[A] Ed25519 signature must verify");

  // Negative: tampered authority must fail (anti-replay across hosts)
  const tampered = rebuiltBase.replace(authority, "evil.example");
  const bad = await crypto.subtle.verify("Ed25519", verifyKey, Buffer.from(sigB64, "base64"), enc.encode(tampered));
  assert(!bad, "[A] signature must NOT verify for a different authority");

  console.log("✅ [A] REQUEST signature: sign → verify OK; cross-host replay rejected");
  console.log(`   Signature-Input: ${sentHeaders["signature-input"].slice(0, 96)}...`);
}

// ============================================================
// PART B — DIRECTORY self-signature (response we serve)
// Per Cloudflare Bot Directory spec:
//   component list: ("@authority";req "signature-agent")
//   ;req = @authority derived from the incoming request that triggered this response
//   tag="http-message-signatures-directory"
//   nonce = 32 random bytes (base64) to prevent response replay
// ============================================================
{
  const directoryUrl = "https://aibotauth.com/.well-known/http-message-signatures-directory";
  const authority = new URL(directoryUrl).host.toLowerCase(); // "aimark.pages.dev"
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 300;
  const nonce = randomBytes(32).toString("base64");

  // Build directory signature base — component identifier includes ;req
  const params = `("@authority";req "signature-agent");created=${created};expires=${expires};keyid="${kid}";alg="ed25519";tag="http-message-signatures-directory";nonce="${nonce}"`;
  const base = `"@authority": ${authority}\n"signature-agent": ${agentField}\n"@signature-params": ${params}`;
  const sigBytes = await crypto.subtle.sign("Ed25519", pair.privateKey, enc.encode(base));

  const sentHeaders = {
    "signature-agent": agentField,
    "signature-input": `sig1=${params}`,
    "signature": `sig1=:${b64(sigBytes)}:`,
  };

  // Verifier checks component list includes ;req on @authority
  const m = sentHeaders["signature-input"].match(/^sig1=\((.*?)\);(.*)$/);
  assert(m, "[B] Signature-Input must parse");
  const rawComponentList = m[1]; // e.g. '"@authority";req "signature-agent"'
  assert(rawComponentList.includes('"@authority";req'), "[B] @authority must carry ;req flag");
  assert(rawComponentList.includes('"signature-agent"'), "[B] signature-agent present");

  const p = Object.fromEntries(
    m[2].split(";").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1).replace(/^"|"$/g, "")];
    }),
  );
  assert.equal(p.tag, "http-message-signatures-directory", "[B] tag");
  assert.equal(p.alg, "ed25519", "[B] alg");
  assert.equal(p.keyid, kid, "[B] keyid matches directory");
  assert(p.nonce && p.nonce.length > 0, "[B] nonce present");
  const now = Math.floor(Date.now() / 1000);
  assert(Number(p.created) <= now && now <= Number(p.expires), "[B] within validity window");

  // Verifier rebuilds the base from what it observed (must match exactly)
  const rebuiltParams = `("@authority";req "signature-agent");created=${p.created};expires=${p.expires};keyid="${p.keyid}";alg="ed25519";tag="${p.tag}";nonce="${p.nonce}"`;
  const rebuiltBase = `"@authority": ${authority}\n"signature-agent": ${agentField}\n"@signature-params": ${rebuiltParams}`;
  assert.equal(rebuiltBase, base, "[B] verifier reconstructs identical base");

  const sigB64 = sentHeaders["signature"].match(/^sig1=:(.+):$/)[1];
  const ok = await crypto.subtle.verify("Ed25519", verifyKey, Buffer.from(sigB64, "base64"), enc.encode(rebuiltBase));
  assert(ok, "[B] Ed25519 directory signature must verify");

  // Negative: wrong host must fail (directory sig bound to our host only)
  const tampered = rebuiltBase.replace(authority, "impostor.example");
  const bad = await crypto.subtle.verify("Ed25519", verifyKey, Buffer.from(sigB64, "base64"), enc.encode(tampered));
  assert(!bad, "[B] directory signature must NOT verify for wrong host");

  // Directory JSON shape check
  const directory = { keys: [{ ...pubJwk, kid, alg: "EdDSA", use: "sig" }] };
  assert(directory.keys[0].x && !directory.keys[0].d, "[B] directory must contain public key only");

  console.log("✅ [B] DIRECTORY signature: sign → verify OK; wrong-host rejected; nonce present");
  console.log(`   Signature-Input: ${sentHeaders["signature-input"].slice(0, 96)}...`);
}

console.log(`\n✅ All Web Bot Auth assertions passed. kid=${kid}`);
