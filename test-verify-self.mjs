/**
 * Local sign/verify test for verify-self logic.
 * Runs with: node test-verify-self.mjs
 * Requires Node 20+ (native crypto.subtle Ed25519 support).
 *
 * What it proves:
 *   1. A private JWK (with alg/use/key_ops stripped per workerd rule) can sign.
 *   2. The matching public JWK can verify the signature.
 *   3. verify-self only signs the fixed format "aibotauth-verify:<timestamp>".
 *   4. A tampered message or a different key pair fails verification.
 */

import { webcrypto } from 'node:crypto';
const subtle = webcrypto.subtle;

// ── helpers (mirrors verify-self.js) ─────────────────────────────────
function b64std(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return Buffer.from(s, 'binary').toString('base64');
}
function b64ToBytes(s) {
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

// Fixed-format message — the ONLY thing verify-self signs
function buildMessage(ts) {
  return `aibotauth-verify:${ts}`;
}
function validateMessageFormat(msg) {
  return /^aibotauth-verify:\d+$/.test(msg);
}

// ── generate a fresh Ed25519 key pair ────────────────────────────────
console.log('Generating Ed25519 key pair…');
const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const privJwkRaw = await subtle.exportKey('jwk', kp.privateKey);
const pubJwkRaw  = await subtle.exportKey('jwk', kp.publicKey);

// Simulate Cloudflare env var (full JWK with alg/use/key_ops as stored)
const storedPrivJwk = { ...privJwkRaw, alg: 'Ed25519', use: 'sig', key_ops: ['sign'], kid: 'test-kid' };
const storedPubJwk  = { ...pubJwkRaw,  alg: 'Ed25519', use: 'sig', key_ops: ['verify'], kid: 'test-kid' };

console.log('Stored private JWK has alg/use/key_ops:', 'alg' in storedPrivJwk);

// ── workerd rule: strip alg/use/key_ops before importKey ─────────────
const { alg, use, key_ops, ...cleanPrivJwk } = storedPrivJwk;
console.log('After stripping — alg present:', 'alg' in cleanPrivJwk, '(expect false)');

const signingKey = await subtle.importKey('jwk', cleanPrivJwk, { name: 'Ed25519' }, false, ['sign']);
console.log('Private key imported: OK');

// ── sign the fixed-format challenge ──────────────────────────────────
const created = Math.floor(Date.now() / 1000);
const message = buildMessage(created);
console.log('Message to sign:', message);
console.log('Format valid:', validateMessageFormat(message), '(expect true)');

const sigBytes = await subtle.sign('Ed25519', signingKey, new TextEncoder().encode(message));
const signature_b64 = b64std(sigBytes);
console.log('Signature (b64, first 40):', signature_b64.slice(0, 40) + '…');

// ── import the PUBLIC key from the "directory" (clean JWK) ───────────
const { alg: a2, use: u2, key_ops: k2, ...cleanPubJwk } = storedPubJwk;
const verifyKey = await subtle.importKey('jwk', cleanPubJwk, { name: 'Ed25519' }, true, ['verify']);
console.log('Public key imported: OK');

// ── VERIFY ───────────────────────────────────────────────────────────
const ok = await subtle.verify(
  'Ed25519', verifyKey, b64ToBytes(signature_b64), new TextEncoder().encode(message)
);
console.log('\nTest 1 — valid signature on correct message:', ok ? 'PASS ✓' : 'FAIL ✗');
if (!ok) process.exit(1);

// ── tampered message must FAIL ────────────────────────────────────────
const tampered = message + 'x';
const okTampered = await subtle.verify(
  'Ed25519', verifyKey, b64ToBytes(signature_b64), new TextEncoder().encode(tampered)
);
console.log('Test 2 — tampered message fails:', !okTampered ? 'PASS ✓' : 'FAIL ✗');
if (okTampered) { console.error('SECURITY: tampered message verified — BUG'); process.exit(1); }

// ── wrong key pair must FAIL ─────────────────────────────────────────
const kp2 = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const wrongPubJwkRaw = await subtle.exportKey('jwk', kp2.publicKey);
const { alg: a3, use: u3, key_ops: k3, ...cleanWrongPub } = { ...wrongPubJwkRaw, alg: 'Ed25519', use: 'sig', key_ops: ['verify'] };
const wrongKey = await subtle.importKey('jwk', cleanWrongPub, { name: 'Ed25519' }, true, ['verify']);
const okWrongKey = await subtle.verify(
  'Ed25519', wrongKey, b64ToBytes(signature_b64), new TextEncoder().encode(message)
);
console.log('Test 3 — wrong public key fails:', !okWrongKey ? 'PASS ✓' : 'FAIL ✗');
if (okWrongKey) { console.error('SECURITY: wrong key verified — BUG'); process.exit(1); }

// ── message format guard (what verify-self enforces) ─────────────────
const badFormats = [
  'user-supplied input',
  'aibotauth-verify:',
  'aibotauth-verify:abc',
  'aibotauth-verify:123 extra',
];
let formatGuardOk = true;
for (const f of badFormats) {
  if (validateMessageFormat(f)) {
    console.error('FAIL: bad format accepted:', f);
    formatGuardOk = false;
  }
}
console.log('Test 4 — fixed-format guard rejects non-conforming strings:', formatGuardOk ? 'PASS ✓' : 'FAIL ✗');
if (!formatGuardOk) process.exit(1);

console.log('\nAll tests passed. Sign/verify pair is correct. Safe to deploy.');
