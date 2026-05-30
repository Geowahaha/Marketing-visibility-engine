const html = (body, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });

function decodeState(state) {
  try {
    const padded = state + "=".repeat((4 - state.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return { next: "/" };
  }
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!r.ok) throw new Error(data.error_description || data.error || text.slice(0, 200));
  return data;
}

function safeNext(next) {
  return String(next || "/").startsWith("/") ? String(next || "/") : "/";
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const provider = String(params.provider || "").toLowerCase();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = decodeState(url.searchParams.get("state") || "");
  const origin = `${url.protocol}//${url.host}`;
  if (!code) return html("Login failed: missing OAuth code.", 400);

  try {
    let profile = null;
    if (provider === "github") {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Error("GitHub OAuth is not configured.");
      const token = await fetchJson("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${origin}/api/auth/callback/github`,
        }),
      });
      profile = await fetchJson("https://api.github.com/user", {
        headers: { authorization: `Bearer ${token.access_token}`, "user-agent": "AI-Mark/1.0" },
      });
    } else if (provider === "google" || provider === "gmail") {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth is not configured.");
      const token = await fetchJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: `${origin}/api/auth/callback/google`,
        }),
      });
      profile = await fetchJson("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
    } else {
      return html("Unsupported login provider.", 400);
    }

    const publicUser = {
      provider: provider === "gmail" ? "google" : provider,
      name: profile.name || profile.login || profile.email || "Signed in user",
      email: profile.email || "",
      avatar: profile.avatar_url || profile.picture || "",
    };
    const cookieValue = encodeURIComponent(JSON.stringify(publicUser));
    return html(`<!doctype html><meta charset="utf-8"><script>localStorage.setItem('aimark_user', ${JSON.stringify(JSON.stringify(publicUser))}); location.href=${JSON.stringify(safeNext(state.next))};</script><p>Signed in. Returning to AI Mark…</p>`, 200, {
      "set-cookie": `aimark_user=${cookieValue}; Path=/; Max-Age=604800; SameSite=Lax; Secure`,
    });
  } catch (e) {
    return html(`Login setup/error: ${String(e).replace(/[<>&]/g, "")}`, 500);
  }
}
