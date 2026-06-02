import { authSecret, decryptSecret, encryptSecret } from "./_auth.js";

const enc = new TextEncoder();

export async function gh(token, method, path, body, authPrefix = "Bearer") {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `${authPrefix} ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "AI-Mark-GitHub-Connect",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, scopes: r.headers.get("x-oauth-scopes") || "" };
}

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemBytes(pem) {
  const b64 = String(pem || "").replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function derLen(n) {
  if (n < 128) return new Uint8Array([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 255);
    n >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derSeq(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(1 + derLen(len).length + len);
  out[0] = 0x30;
  out.set(derLen(len), 1);
  let off = 1 + derLen(len).length;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function derOctet(bytes) {
  const len = derLen(bytes.length);
  const out = new Uint8Array(1 + len.length + bytes.length);
  out[0] = 0x04;
  out.set(len, 1);
  out.set(bytes, 1 + len.length);
  return out;
}

function pkcs1ToPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaOid = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return derSeq(version, rsaOid, derOctet(pkcs1));
}

async function importGithubPrivateKey(pem) {
  const der = pemBytes(pem);
  const pkcs8 = String(pem || "").includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function githubAppJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) })));
  const body = `${header}.${payload}`;
  const key = await importGithubPrivateKey(pem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function storeGithubApp(env, session, app) {
  const secret = authSecret(env);
  if (!secret || !env.ENTITLEMENTS_KV || !session?.sid) return false;
  const encryptedPem = await encryptSecret(app.pem || "", secret);
  await env.ENTITLEMENTS_KV.put(`github:app:${session.sid}`, JSON.stringify({
    app_id: app.id,
    slug: app.slug || "",
    name: app.name || "",
    html_url: app.html_url || "",
    client_id: app.client_id || "",
    encrypted_pem: encryptedPem,
    created_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 90 });
  return true;
}

export async function storeGithubInstallation(env, session, installationId) {
  if (!env.ENTITLEMENTS_KV || !session?.sid || !installationId) return false;
  await env.ENTITLEMENTS_KV.put(`github:install:${session.sid}`, JSON.stringify({
    installation_id: String(installationId),
    installed_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 90 });
  return true;
}

export async function githubInstallationToken(env, session) {
  const secret = authSecret(env);
  if (!secret || !env.ENTITLEMENTS_KV || !session?.sid) return null;
  const app = await env.ENTITLEMENTS_KV.get(`github:app:${session.sid}`, "json").catch(() => null);
  const install = await env.ENTITLEMENTS_KV.get(`github:install:${session.sid}`, "json").catch(() => null);
  if (!app?.app_id || !app?.encrypted_pem || !install?.installation_id) return null;
  const pem = await decryptSecret(app.encrypted_pem, secret);
  const jwt = await githubAppJwt(app.app_id, pem);
  const res = await gh(jwt, "POST", `/app/installations/${install.installation_id}/access_tokens`, null, "Bearer");
  if (!res.ok || !res.data?.token) return null;
  return { token: res.data.token, kind: "github_app", login: app.slug || "", installation_id: install.installation_id };
}

export async function connectedGithubToken(env, session) {
  const secret = authSecret(env);
  if (!secret || !env.ENTITLEMENTS_KV || !session?.sid) return null;
  const oauth = await env.ENTITLEMENTS_KV.get(`oauth:github:${session.sid}`, "json").catch(() => null);
  if (oauth?.encrypted_access_token) {
    return {
      token: await decryptSecret(oauth.encrypted_access_token, secret),
      kind: oauth.provider || "oauth",
      login: oauth.login || session.login || "",
    };
  }
  return githubInstallationToken(env, session);
}
