const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function listEnv(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function permission(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const bypassIps = [...listEnv(env.EXPORT_BYPASS_IPS), ...listEnv(env.RATE_LIMIT_BYPASS_IPS)];
  if (ip && bypassIps.includes(ip)) return { allowed: true, reason: "tester_ip_bypass" };
  return { allowed: false, reason: "paid_watchtower_required" };
}

function compactFindings(scan) {
  const out = [];
  for (const cat of scan.categories || []) {
    for (const f of cat.findings || []) {
      const status = String(f.status || "info").toLowerCase();
      if (status === "fail" || status === "warn") {
        out.push({
          category: cat.name || "Visibility",
          severity: String(f.severity || "low").toLowerCase(),
          check: f.check || "Visibility issue",
          fix: f.fix || f.detail || "Review and improve this issue.",
        });
      }
    }
  }
  return out.slice(0, 12);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const p = permission(request, env);
  if (!p.allowed) {
    return json({
      error: "AI Mark Watchtower requires a paid package.",
      upgrade_required: true,
      cta: {
        th: "เริ่ม AI Mark Watchtower เพื่อเฝ้าติดตามและสั่งแก้เมื่อ Search/AI เปลี่ยน",
        en: "Start AI Mark Watchtower to monitor and fix visibility as search/AI changes.",
      },
    }, 402);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const scan = body.scan || body;
  const watch = {
    watchtower_version: "1.0",
    action_type: "aimark.watchtower.start",
    status: env.WATCHTOWER_WEBHOOK_URL ? "ready_to_send" : "ready_for_setup",
    source_url: "https://aimark.pages.dev",
    package_name: "AI Mark Watchtower",
    permission: p,
    client: {
      website_url: scan.url || "",
      baseline_score: Number(scan.overall || 0),
      baseline_grade: scan.grade || "",
      baseline_summary: scan.summary || "",
    },
    cadence: "daily_light_check + weekly_deep_recommendation",
    monitored_surfaces: [
      "Google Search readiness",
      "Bing / Edge / Copilot readiness",
      "AI crawler access",
      "llms.txt / AI JSON / schema evidence",
      "robots and sitemap regressions",
      "Open Graph and social previews",
      "content freshness and entity clarity",
    ],
    next_best_actions: compactFindings(scan),
    promise_boundary: "Monitor evidence and readiness, prioritize fixes, and trigger agent/human actions. Do not promise instant ranking.",
    created_at: new Date().toISOString(),
  };

  if (!env.WATCHTOWER_WEBHOOK_URL) {
    return json({
      status: "watchtower_ready",
      connected: false,
      setup_required: "Set WATCHTOWER_WEBHOOK_URL to enqueue continuous monitoring automatically.",
      message: {
        th: "เตรียม Watchtower plan แล้ว ยังไม่ได้เชื่อมระบบติดตามอัตโนมัติ",
        en: "Watchtower plan is ready. Connect WATCHTOWER_WEBHOOK_URL to automate monitoring.",
      },
      watchtower: watch,
    });
  }

  const headers = { "content-type": "application/json" };
  if (env.WATCHTOWER_WEBHOOK_TOKEN) headers.authorization = `Bearer ${env.WATCHTOWER_WEBHOOK_TOKEN}`;
  const upstream = await fetch(env.WATCHTOWER_WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify(watch) });
  const text = await upstream.text();
  let upstreamBody;
  try { upstreamBody = JSON.parse(text); } catch { upstreamBody = { body: text.slice(0, 1000) }; }
  return json({ status: upstream.ok ? "watchtower_started" : "watchtower_error", connected: true, bridge_status: upstream.status, upstream: upstreamBody, watchtower: watch }, upstream.ok ? 200 : 502);
}
