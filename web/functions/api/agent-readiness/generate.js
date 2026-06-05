/**
 * POST /api/agent-readiness/generate
 * Returns a deploy-ready bundle of agent-readiness files for a site (we DO it,
 * not a copy-paste prompt). The sellable SME deliverable. Login required.
 * Body: { url, name?, description?, contact_email?, key_pages?, has_oauth? }
 */
import { json, requireSession } from "../_auth.js";
import { generateAgentReadinessBundle } from "../_agent_readiness.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);

  let body = {};
  try { body = await request.json(); } catch { return jc({ error: "invalid_json" }, 400); }
  const bundle = generateAgentReadinessBundle(body);
  if (bundle.error) return jc({ error: bundle.error }, 400);

  return jc({
    status: "generated",
    host: bundle.host,
    count: bundle.count,
    files: bundle.files,
    deploy_hint: "Upload each file at the given path from your site root (e.g. /llms.txt, /.well-known/agent-skills/index.json), then re-scan.",
  });
}
