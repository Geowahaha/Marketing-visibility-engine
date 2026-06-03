/**
 * AI Mark — MCP server over HTTP  (POST /api/mcp)
 * ------------------------------------------------------------------
 * The real adapter: external models connect AI Mark as a tool provider through
 * the Model Context Protocol — the same standard behind the Anthropic MCP
 * connector and the OpenAI Apps SDK. One endpoint, JSON-RPC 2.0.
 *
 * Implemented methods: initialize, notifications/initialized, ping,
 * tools/list, tools/call. Tools and execution come from _tools.js (derived from
 * the skill registry), so every AI Mark skill is reachable by any MCP client
 * with the same approval/credit guardrails as the web app.
 *
 * GET /api/mcp returns a human/agent-readable description of the server.
 */

import { toolDefinitions, executeTool } from "./_tools.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "aimark", title: "AI Mark", version: "1.0.0" };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,mcp-protocol-version",
};

// JSON-RPC envelope builders (plain objects; the route serializes them).
function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

/** MCP tools/list shape — strip internal-only keys but keep _aimark hints. */
function listForMcp() {
  return toolDefinitions().map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    _meta: t._aimark,
  }));
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export function onRequestGet(context) {
  return new Response(
    JSON.stringify({
      service: "aimark-mcp",
      protocol: "mcp",
      transport: "http",
      jsonrpc_endpoint: new URL("/api/mcp", context.request.url).toString(),
      protocol_version: PROTOCOL_VERSION,
      server: SERVER_INFO,
      tool_count: listForMcp().length,
      note: "POST JSON-RPC 2.0 here. Methods: initialize, tools/list, tools/call. Connect from the Anthropic MCP connector or the OpenAI Apps SDK.",
    }, null, 2),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8", ...CORS } },
  );
}

export async function onRequestPost(context) {
  let msg;
  try { msg = await context.request.json(); } catch { return jsonResponse(rpcError(null, -32700, "Parse error"), 400); }

  // Minimal batch support.
  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) {
      const res = await handleOne(m, context);
      if (res) out.push(res);
    }
    return jsonResponse(out);
  }

  const single = await handleOne(msg, context);
  if (single === null) return new Response(null, { status: 202, headers: CORS }); // notification, no body
  return jsonResponse(single);
}

async function handleOne(msg, context) {
  const id = msg && Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};

  // Notifications (no id) — acknowledge without a result.
  if (id === undefined) {
    return null;
  }

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "AI Mark exposes AI-visibility skills as tools. Read-only audits (scan, tech_audit, conversion_audit, local_seo_audit, social_visibility, competitor, citation_probe, answer_gap, lead_scout, bot intel) run directly and return structured, honest results — never ranking guarantees. Skills that change a site, send messages, or spend credits require owner approval in the AI Mark web app.",
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: listForMcp() });

    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const out = await executeTool(name, args, context);
      const payload = out.ok ? out.result : { error: out.error, detail: out.detail, status: out.status };
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: out.ok ? out.result : undefined,
        isError: !out.ok,
      });
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method || "(none)"}`);
  }
}
