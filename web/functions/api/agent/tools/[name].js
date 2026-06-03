/**
 * Cloudflare Pages Function — POST /api/agent/tools/:name
 * ------------------------------------------------------------------
 * REST executor for one AI Mark tool. Body = the tool arguments (e.g. {url}).
 * Dispatches through the shared executor with the same approval/credit
 * guardrails as the MCP server. Read-only audits run; write/deploy/send skills
 * return { error: "approval_required" }.
 */

import { executeTool } from "../../_tools.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const name = context.params && context.params.name;
  let args = {};
  try { args = await context.request.json(); } catch { /* allow empty body */ }
  const out = await executeTool(name, args, context);
  if (out.ok) return json({ ok: true, tool: out.tool, result: out.result });
  return json({ ok: false, tool: name, error: out.error, detail: out.detail }, out.status || 400);
}
