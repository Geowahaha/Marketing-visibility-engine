import { json, requireSession } from "../_auth.js";
import { connectedGithubToken, gh } from "../_github.js";

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Sign in with GitHub first." }, 401);
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const repo = String(payload.repo || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return json({ error: "Repo must be owner/name." }, 400);

  const connected = await connectedGithubToken(env, session);
  if (!connected?.token) return json({ error: "GitHub repo access is not connected.", reconnect_url: "/api/github/app/start" }, 409);
  const res = await gh(connected.token, "GET", `/repos/${repo}`);
  if (!res.ok) return json({ error: "Cannot access this repo with the connected GitHub account.", detail: res.data?.message, status: res.status }, 403);

  await env.ENTITLEMENTS_KV?.put(`github:repo:${session.sid}`, JSON.stringify({
    repo,
    default_branch: res.data.default_branch || "",
    html_url: res.data.html_url || "",
    selected_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ ok: true, repo, default_branch: res.data.default_branch || "", html_url: res.data.html_url || "" });
}
