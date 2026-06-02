const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

function originFromRequest(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function setupRequired(provider, missing) {
  return json({
    provider,
    setup_required: true,
    error: `${provider} login is not configured yet.`,
    missing_env: missing,
    message: "Add OAuth client credentials in Cloudflare Pages secrets, then retry.",
  }, 501);
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const provider = String(params.provider || "").toLowerCase();
  const origin = originFromRequest(request);
  const url = new URL(request.url);
  const next = url.searchParams.get("next") || "/";
  const state = btoa(JSON.stringify({ next, ts: Date.now() })).replace(/=+$/g, "");

  if (provider === "github") {
    if (url.searchParams.get("check") === "1") {
      const ready = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
      return json({ provider: "github", ready, missing_env: ready ? [] : ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] });
    }
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return setupRequired("github", ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
    }
    const redirectUri = `${origin}/api/auth/callback/github`;
    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "repo read:user user:email");
    authUrl.searchParams.set("state", state);
    return Response.redirect(authUrl.toString(), 302);
  }

  if (provider === "google" || provider === "gmail") {
    if (url.searchParams.get("check") === "1") {
      const ready = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
      return json({ provider: "google", ready, missing_env: ready ? [] : ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] });
    }
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return setupRequired("google", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    }
    const redirectUri = `${origin}/api/auth/callback/google`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("access_type", "online");
    return Response.redirect(authUrl.toString(), 302);
  }

  return json({ error: "Unsupported login provider." }, 400);
}
