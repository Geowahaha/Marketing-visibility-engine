import { json, requireSession } from "../../_auth.js";
import { storeGithubApp } from "../../_github.js";

function originOf(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function safeHtml(s) {
  return String(s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

function errorPage(request, message, detail = "", status = 500) {
  const target = `${originOf(request)}/?modal=login&github=error`;
  return new Response(`<!doctype html>
<meta charset="utf-8">
<title>GitHub Connect</title>
<p>${safeHtml(message)}</p>
${detail ? `<p>${safeHtml(detail)}</p>` : ""}
<p><a href="${target}">Return to AI Mark</a></p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const session = await requireSession(request, env);
    if (!session) return errorPage(request, "GitHub App setup expired. Return to AI Mark and try again.", "", 401);
    const stateRec = state && await env.ENTITLEMENTS_KV?.get(`github:manifest_state:${state}`, "json").catch(() => null);
    if (!code || !stateRec || stateRec.sid !== session.sid) return errorPage(request, "GitHub App setup state mismatch.", "", 400);

    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "AI-Mark-GitHub-Connect",
      },
    });
    const app = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: "Could not create GitHub App from manifest.", detail: app.message || app }, 502);
    const stored = await storeGithubApp(env, session, app);
    if (!stored) return errorPage(request, "GitHub App was created, but AI Mark could not save the connector state.", "Check ENTITLEMENTS_KV and AUTH_SESSION_SECRET.", 500);
    await env.ENTITLEMENTS_KV?.delete(`github:manifest_state:${state}`).catch(() => {});

    const slug = app.slug || "";
    const installUrl = slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : app.html_url;
    return new Response(`<!doctype html>
<meta charset="utf-8">
<title>Install AI Mark Connector</title>
<script>location.href=${JSON.stringify(installUrl)}</script>
<p>GitHub App created. Opening installation screen for ${safeHtml(app.name || slug)}...</p>
<p><a href="${safeHtml(installUrl)}">Continue to GitHub installation</a></p>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (e) {
    console.error("github_app_callback_failed", e && (e.stack || e.message || String(e)));
    return errorPage(request, "GitHub connect failed inside AI Mark.", e && (e.message || String(e)), 500);
  }
}
