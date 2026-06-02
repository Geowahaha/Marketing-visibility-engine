import { json, requireSession } from "../_auth.js";
import { connectedGithubToken, gh } from "../_github.js";

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: "Sign in with GitHub first." }, 401);
  const connected = await connectedGithubToken(env, session);
  if (!connected?.token) return json({ error: "GitHub repo access is not connected.", reconnect_url: "/api/github/app/start" }, 409);

  const selected = await env.ENTITLEMENTS_KV?.get(`github:repo:${session.sid}`, "json").catch(() => null);
  const path = connected.kind === "github_app"
    ? "/installation/repositories?per_page=100"
    : "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member";
  const res = await gh(connected.token, "GET", path);
  if (!res.ok) return json({ error: "Could not list GitHub repositories.", detail: res.data?.message, status: res.status }, 502);

  const rawRepos = connected.kind === "github_app" ? res.data?.repositories : res.data;
  const repos = (Array.isArray(rawRepos) ? rawRepos : []).map((r) => ({
    full_name: r.full_name,
    private: !!r.private,
    default_branch: r.default_branch,
    pushed_at: r.pushed_at,
    html_url: r.html_url,
    permissions: r.permissions || {},
  }));
  return json({ repos, selected_repo: selected?.repo || "" });
}
