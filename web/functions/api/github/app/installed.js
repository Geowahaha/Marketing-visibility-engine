import { requireSession } from "../../_auth.js";
import { storeGithubInstallation } from "../../_github.js";

function originOf(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function htmlRedirect(request, path, message) {
  const target = `${originOf(request)}${path}`;
  return new Response(`<!doctype html>
<meta charset="utf-8">
<title>Returning to AI Mark</title>
<script>location.replace(${JSON.stringify(target)})</script>
<p>${message || "Returning to AI Mark..."}</p>
<p><a href="${target}">Continue</a></p>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const session = await requireSession(request, env);
    if (!session) return htmlRedirect(request, "/?modal=login&github=expired", "GitHub approval expired. Return to AI Mark and try again.");
    const url = new URL(request.url);
    const installationId = url.searchParams.get("installation_id") || "";
    if (installationId) await storeGithubInstallation(env, session, installationId);
    const target = installationId
      ? "/?modal=login&github=installed"
      : "/?modal=login&github=setup";
    return htmlRedirect(request, target, installationId ? "GitHub repo access connected." : "GitHub setup needs one more step.");
  } catch (e) {
    console.error("github_app_installed_failed", e && (e.stack || e.message || String(e)));
    return htmlRedirect(request, "/?modal=login&github=error", "GitHub connect hit a setup error. Return to AI Mark and retry.");
  }
}
