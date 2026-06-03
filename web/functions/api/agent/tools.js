/**
 * Cloudflare Pages Function — GET /api/agent/tools
 * ------------------------------------------------------------------
 * Plain-REST view of the AI Mark tool contract for adapters that prefer HTTP
 * over MCP (OpenAI function-calling, custom agents). Same tools, same registry.
 * Execute a tool with POST /api/agent/tools/:name.
 */

import { toolDefinitions } from "../_tools.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export function onRequestGet(context) {
  const tools = toolDefinitions();
  // Also emit an OpenAI function-calling view so an adapter can paste it directly.
  const openai_tools = tools
    .filter((t) => t._aimark.executable)
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  return new Response(
    JSON.stringify({
      service: "aimark-agent-tools",
      mcp_endpoint: new URL("/api/mcp", context.request.url).toString(),
      exec_endpoint: new URL("/api/agent/tools/", context.request.url).toString(),
      count: tools.length,
      tools,
      openai_tools,
    }, null, 2),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8", ...CORS } },
  );
}
