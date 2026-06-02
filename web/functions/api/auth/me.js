import { json, parseCookies, publicUser, requireSession } from "../_auth.js";
import { agentKv, publicAgent } from "../_agent.js";

function readUser(request) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const raw = cookies.aimark_user;
  if (!raw) return null;
  try {
    const user = JSON.parse(decodeURIComponent(raw));
    if (!user || typeof user !== "object") return null;
    return {
      provider: user.provider || "",
      name: user.name || user.email || "Signed in user",
      email: String(user.email || "").toLowerCase(),
      avatar: user.avatar || "",
    };
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  const session = await requireSession(request, env);
  const user = session ? publicUser(session) : readUser(request);
  let credits = { balance: 0, lifetime_purchased: 0, lifetime_spent: 0, recent_ledger: [] };
  let github = { connected: false, selected_repo: "" };
  let agent = { connected: false };
  if (user?.email && env.ENTITLEMENTS_KV) {
    try {
      credits = (await env.ENTITLEMENTS_KV.get(`credits:email:${user.email}`, "json")) || credits;
      const ledger = (await env.ENTITLEMENTS_KV.get(`credit:ledger:${user.email}`, "json")) || [];
      credits.recent_ledger = Array.isArray(ledger) ? ledger.slice(-10).reverse() : [];
      credits.lifetime_spent = Math.max(0, Number(credits.lifetime_spent || 0));
    } catch {
      credits = { balance: 0, lifetime_purchased: 0, lifetime_spent: 0, recent_ledger: [] };
    }
  }
  if (session?.sid && env.ENTITLEMENTS_KV) {
    try {
      const oauth = await env.ENTITLEMENTS_KV.get(`oauth:github:${session.sid}`, "json");
      const app = await env.ENTITLEMENTS_KV.get(`github:app:${session.sid}`, "json");
      const install = await env.ENTITLEMENTS_KV.get(`github:install:${session.sid}`, "json");
      const selected = await env.ENTITLEMENTS_KV.get(`github:repo:${session.sid}`, "json");
      github = {
        connected: !!oauth || !!install,
        login: oauth?.login || app?.slug || session.login || "",
        selected_repo: selected?.repo || "",
        method: oauth ? "oauth" : install ? "github_app" : "",
      };
    } catch {
      github = { connected: false, selected_repo: "" };
    }
    try {
      const store = agentKv(env);
      const pairedAgent = store ? await store.get(`agent_user:${session.sid}`, "json") : null;
      agent = pairedAgent ? { connected: true, ...publicAgent(pairedAgent) } : { connected: false };
    } catch {
      agent = { connected: false };
    }
  }

  return json({
    authenticated: !!session,
    user,
    credits,
    github,
    agent,
    login_ready: {
      google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    },
  });
}
