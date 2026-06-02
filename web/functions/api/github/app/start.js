import { authSecret, publicUser, requireSession, signSession } from "../../_auth.js";

function originOf(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function autoForm(action, manifest, state, cookies = []) {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(`<!doctype html>
<meta charset="utf-8">
<title>Redirecting to GitHub</title>
<form id="f" action="${action}?state=${encodeURIComponent(state)}" method="post">
  <input type="hidden" name="manifest" value="${String(JSON.stringify(manifest)).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">
  <button>Approve on GitHub</button>
</form>
<script>document.getElementById("f").submit()</script>
<p>Opening GitHub's official approval screen...</p>`, { status: 200, headers });
}

export async function onRequestGet({ request, env }) {
  const secret = authSecret(env);
  if (!secret) return new Response("AUTH_SESSION_SECRET is required.", { status: 500 });
  const origin = originOf(request);
  const current = await requireSession(request, env);
  const signed = current
    ? await signSession(current, secret)
    : await signSession({ provider: "github_app", name: "GitHub owner", email: "", login: "" }, secret);
  const user = publicUser(signed.session);
  const userCookie = encodeURIComponent(JSON.stringify(user));
  const cookies = [
    `aimark_session=${signed.token}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure`,
    `aimark_user=${userCookie}; Path=/; Max-Age=604800; SameSite=Lax; Secure`,
  ];

  const state = crypto.randomUUID();
  await env.ENTITLEMENTS_KV?.put(`github:manifest_state:${state}`, JSON.stringify({
    sid: signed.session.sid,
    created_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 });

  const suffix = signed.session.sid.slice(0, 6);
  const manifest = {
    name: `AI Mark Connector ${suffix}`,
    url: origin,
    hook_attributes: { url: `${origin}/api/github/webhook`, active: false },
    redirect_url: `${origin}/api/github/app/callback`,
    callback_urls: [`${origin}/api/github/app/installed`],
    setup_url: `${origin}/api/github/app/installed`,
    description: "AI Mark opens safe reviewable pull requests for approved website visibility fixes.",
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    },
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: true,
  };
  return autoForm("https://github.com/settings/apps/new", manifest, state, cookies);
}
