import { authSecret, encryptSecret, json, publicUser, requireSession, signSession } from "../_auth.js";

async function gh(token, path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "AI-Mark-GitHub-Connect",
    },
  });
  const data = await r.json().catch(() => ({}));
  return {
    ok: r.ok,
    status: r.status,
    data,
    scopes: r.headers.get("x-oauth-scopes") || "",
  };
}

async function githubEmail(token, profile) {
  if (profile?.email) return profile.email;
  const emails = await gh(token, "/user/emails");
  if (!emails.ok || !Array.isArray(emails.data)) return "";
  const primary = emails.data.find((e) => e.primary && e.verified) || emails.data.find((e) => e.verified);
  return primary?.email || "";
}

function userCookies(signed) {
  const publicProfile = publicUser(signed.session);
  const userCookie = encodeURIComponent(JSON.stringify(publicProfile));
  return [
    `aimark_session=${signed.token}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure`,
    `aimark_user=${userCookie}; Path=/; Max-Age=604800; SameSite=Lax; Secure`,
  ];
}

export async function onRequestPost({ request, env }) {
  const secret = authSecret(env);
  if (!secret) return json({ error: "AUTH_SESSION_SECRET is required for GitHub connect." }, 500);
  if (!env.ENTITLEMENTS_KV) return json({ error: "ENTITLEMENTS_KV binding is required for GitHub connect." }, 500);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const token = String(payload.token || "").trim();
  if (!token) return json({ error: "GitHub token is required." }, 400);

  const profile = await gh(token, "/user");
  if (!profile.ok) {
    return json({
      error: "GitHub rejected this token.",
      detail: profile.data?.message || "Invalid or expired token.",
      status: profile.status,
    }, 401);
  }

  const repoProbe = await gh(token, "/user/repos?per_page=1&sort=updated&affiliation=owner,collaborator,organization_member");
  if (!repoProbe.ok) {
    return json({
      error: "This token cannot read repositories.",
      detail: repoProbe.data?.message || "Give the token repo access or selected repository access.",
      status: repoProbe.status,
    }, 403);
  }

  const existing = await requireSession(request, env);
  const email = await githubEmail(token, profile.data);
  const unsignedUser = existing || {
    provider: "github",
    name: profile.data.name || profile.data.login || email || "GitHub owner",
    email,
    avatar: profile.data.avatar_url || "",
    login: profile.data.login || "",
  };
  const signed = existing ? await signSession(existing, secret) : await signSession(unsignedUser, secret);
  const encrypted = await encryptSecret(token, secret);

  await env.ENTITLEMENTS_KV.put(`oauth:github:${signed.session.sid}`, JSON.stringify({
    provider: "github-token",
    encrypted_access_token: encrypted,
    scope: profile.scopes || repoProbe.scopes || "",
    login: profile.data.login || "",
    avatar: profile.data.avatar_url || "",
    connected_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 30 });

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  for (const cookie of userCookies(signed)) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({
    ok: true,
    user: publicUser(signed.session),
    github: {
      connected: true,
      login: profile.data.login || "",
      selected_repo: "",
    },
    scopes: profile.scopes || repoProbe.scopes || "",
  }), { status: 200, headers });
}
