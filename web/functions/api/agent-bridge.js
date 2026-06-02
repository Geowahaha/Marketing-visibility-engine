import { paidStatus } from "./_auth.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function buildBridgePayload(scan, permission) {
  const categories = Array.isArray(scan.categories) ? scan.categories : [];
  const findings = [];
  categories.forEach((cat) => {
    (cat.findings || []).forEach((f) => {
      const status = String(f.status || "info").toLowerCase();
      if (status === "fail" || status === "warn") {
        findings.push({
          category: cat.name || "Visibility",
          severity: String(f.severity || "low").toLowerCase(),
          check: f.check || "Improve visibility item",
          detail: f.detail || "",
          fix: f.fix || "Review and improve this issue.",
        });
      }
    });
  });

  return {
    mcp_action_version: "1.0",
    action_type: "aimark.website_improvement.request",
    source: "AI Mark",
    source_url: "https://aimark.pages.dev",
    package_name: "AI Mark Website Improvement Package",
    permission,
    client: {
      website_url: scan.url || "",
      score: Number(scan.overall || 0),
      grade: scan.grade || "",
      summary: scan.summary || "",
    },
    intent: {
      th: "ให้ AI Agent ปรับปรุงเว็บนี้จากผลสแกนของ AI Mark",
      en: "Send this scan to an AI agent to improve the website from the AI Mark findings.",
    },
    recommended_agent_workflow: [
      {
        step: 1,
        name: "Inspect repo/site access",
        instruction: "Identify the website repository, CMS, or deployment path. If access is missing, ask the owner for the correct repo or admin access.",
      },
      {
        step: 2,
        name: "Implement priority fixes",
        instruction: "Fix critical/high findings first: technical SEO, robots/sitemap, AI-crawler access, structured metadata, Open Graph, content clarity, and trust signals.",
      },
      {
        step: 3,
        name: "Verify live result",
        instruction: "Deploy safely, open the live site in browser, re-run AI Mark scan, and compare before/after score and remaining findings.",
      },
      {
        step: 4,
        name: "Report to client",
        instruction: "Return a brief Thai/English summary: what changed, proof links, before/after score, and next actions.",
      },
    ],
    tools_requested: [
      "github_or_git_repository_access",
      "browser_visual_verification",
      "terminal_build_and_tests",
      "cloudflare_or_hosting_deploy_if_available",
      "aimark_rescan_verification",
    ],
    constraints: [
      "Preserve client brand and visual quality.",
      "Do not expose secrets, API keys, tokens, private lead scoring, or internal Blutenstein mechanics.",
      "Do not overpromise instant Google or AI ranking.",
      "Keep Blutenstein/AI Mark as a subtle trust layer only where appropriate.",
    ],
    priority_findings: findings.slice(0, 20),
    created_at: new Date().toISOString(),
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const status = await paidStatus(request, env, "paid_package_required");
  const permission = { allowed: status.paid, reason: status.reason };
  if (!permission.allowed) {
    return json({
      error: "AI Agent action requires the paid improvement package.",
      upgrade_required: true,
      action_locked: true,
      cta: {
        th: "เริ่มแพ็กเกจให้ AI Mark ปรับปรุงเว็บของคุณ",
        en: "Start the AI Mark website improvement package",
      },
    }, 402);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const scan = payload.scan || payload;
  const bridgePayload = buildBridgePayload(scan, permission);

  if (!env.MCP_BRIDGE_URL) {
    return json({
      status: "ready_for_agent",
      connected: false,
      setup_required: "Set MCP_BRIDGE_URL to send this action directly to a real AI-agent/MCP bridge.",
      message: {
        th: "สร้าง Action สำหรับส่งให้ AI Agent แล้ว แต่ยังไม่ได้ตั้งค่า MCP_BRIDGE_URL เพื่อส่งอัตโนมัติ",
        en: "AI-agent action is ready. Configure MCP_BRIDGE_URL to auto-send it to the agent bridge.",
      },
      mcp_payload: bridgePayload,
    });
  }

  const headers = { "content-type": "application/json" };
  if (env.MCP_BRIDGE_TOKEN) headers.authorization = `Bearer ${env.MCP_BRIDGE_TOKEN}`;

  const upstream = await fetch(env.MCP_BRIDGE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(bridgePayload),
  });
  const text = await upstream.text();
  let upstreamBody;
  try { upstreamBody = JSON.parse(text); } catch { upstreamBody = { body: text.slice(0, 1000) }; }

  return json({
    status: upstream.ok ? "sent_to_agent" : "agent_bridge_error",
    connected: true,
    bridge_status: upstream.status,
    upstream: upstreamBody,
    mcp_payload: bridgePayload,
  }, upstream.ok ? 200 : 502);
}
