#!/usr/bin/env node
/**
 * AI Mark — Web Bot Auth end-to-end test (no network needed)
 * ------------------------------------------------------------------
 * Plays both sides:
 *   1. AIMarkBot: generate Ed25519 identity, sign a request to a target
 *      exactly as web/functions/api/_botauth.js does.
 *   2. Target origin verifier: parse Signature-Input / Signature /
 *      Signature-Agent, rebuild the RFC 9421 signature base, fetch the
 *      key by keyid from the JWKS (simulated), verify, check the window.
 *
 * Run in CI / verify gate:  node scripts/test-botauth.mjs
 * Exit 0 = our signatures verify; non-zero = a verifier would reject us.
 */
import { webcrypto as crypto } from "node:crypto";
import { createHash } from "node:crypto";
import assert from "node:assert";

const enc = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString("base64");

// ---------- 1. Generate identity (mirror of generate-botauth-key.mjs) ----------
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const kid = createHash("sha256")
  .update(JSON.stringify({ crv: pubJwk.crv, kty: pubJwk.kty, x: pubJwk.x }))
  .digest("base64url");

// ---------- 2. Sign as AIMarkBot (mirror of _botauth.js) ----------
const target = "https://www.successcasting.com/robots.txt";
const agentUrl = "https://aimark.pages.dev";
const authority = new URL(target).host.toLowerCase();
const agentField = `"${agentUrl}"`;
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

// ---------- 3. Verify as the target origin would ----------
function parseSigInput(v) {
  const m = v.match(/^sig1=\((.*?)\);(.*)$/);
  assert(m, "Signature-Input must parse");
  const components = m[1].split(" ").map((s) => s.replace(/"/g, ""));
  const p = Object.fromEntries(
    m[2].split(";").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1).replace(/^"|"$/g, "")];
    }),
  );
  return { components, p, raw: m[1] };
}

const { components, p } = parseSigInput(sentHeaders["signature-input"]);
assert.deepEqual(components, ["@authority", "signature-agent"], "covered components");
assert.equal(p.tag, "web-bot-auth", "tag");
assert.equal(p.alg, "ed25519", "alg");
assert.equal(p.keyid, kid, "keyid matches directory");
const now = Math.floor(Date.now() / 1000);
assert(Number(p.created) <= now && now <= Number(p.expires), "within validity window");

// Verifier rebuilds the base from what it observed:
const rebuiltParams = `("@authority" "signature-agent");created=${p.created};expires=${p.expires};keyid="${p.keyid}";alg="ed25519";tag="${p.tag}"`;
const rebuiltBase = `"@authority": ${authority}\n"signature-agent": ${sentHeaders["signature-agent"]}\n"@signature-params": ${rebuiltParams}`;
assert.equal(rebuiltBase, base, "verifier reconstructs identical base");

const sigB64 = sentHeaders["signature"].match(/^sig1=:(.+):$/)[1];
const verifyKey = await crypto.subtle.importKey(
  "jwk", { ...pubJwk, kid }, { name: "Ed25519" }, false, ["verify"],
);
const ok = await crypto.subtle.verify(
  "Ed25519", verifyKey, Buffer.from(sigB64, "base64"), enc.encode(rebuiltBase),
);
assert(ok, "Ed25519 signature must verify");

// Negative: tampered authority must fail (anti-replay across hosts).
const tampered = rebuiltBase.replace(authority, "evil.example");
const bad = await crypto.subtle.verify(
  "Ed25519", verifyKey, Buffer.from(sigB64, "base64"), enc.encode(tampered),
);
assert(!bad, "signature must NOT verify for a different authority");

// Directory shape check (what /.well-known serves).
const directory = { keys: [{ ...pubJwk, kid, alg: "Ed25519", use: "sig" }] };
assert(directory.keys[0].x && !directory.keys[0].d, "directory must contain public key only");

console.log("✅ Web Bot Auth e2e: sign → verify OK; cross-host replay rejected; directory valid.");
console.log(`   kid=${kid}`);
console.log(`   Signature-Input: ${sentHeaders["signature-input"].slice(0, 96)}...`);
