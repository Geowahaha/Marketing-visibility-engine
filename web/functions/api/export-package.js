import { paidStatus } from "./_auth.js";
import { consumeCredits, creditCost } from "./_credits.js";

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
function effortFromSeverity(sev) {
  if (sev === "critical" || sev === "high") return "medium";
  if (sev === "medium") return "small";
  return "small";
}
function impactFromSeverity(sev) {
  if (sev === "critical" || sev === "high") return "high";
  if (sev === "medium") return "medium";
  return "low";
}

function buildActionJson(scan, permission) {
  const cats = Array.isArray(scan.categories) ? scan.categories : [];
  const actions = [];
  cats.forEach((cat) => {
    (cat.findings || []).forEach((finding, idx) => {
      const status = String(finding.status || "info").toLowerCase();
      if (status !== "fail" && status !== "warn") return;
      const severity = String(finding.severity || "low").toLowerCase();
      const check = finding.check || `Improve ${cat.name}`;
      const fix = finding.fix || finding.detail || "Review and improve this item.";
      actions.push({
        id: `aimark-${String(actions.length + 1).padStart(3, "0")}`,
        category: cat.name || "Visibility",
        severity,
        impact: impactFromSeverity(severity),
        effort: effortFromSeverity(severity),
        title: {
          th: check,
          en: check,
        },
        problem: {
          th: finding.detail || check,
          en: finding.detail || check,
        },
        recommended_fix: {
          th: fix,
          en: fix,
        },
        ai_agent_instruction:
          `Inspect the client website for '${check}' under '${cat.name}'. Implement the safest concrete fix: ${fix}. Preserve the client brand and verify the live site after deployment.`,
        human_instruction:
          `ให้ทีมตรวจหัวข้อ '${check}' และดำเนินการแก้ตามนี้: ${fix}`,
        verification: [
          "Run the AI Mark scan again and confirm this finding improves or disappears.",
          "Verify the public website in a browser after deployment.",
          "Confirm no API keys, internal notes, or private Blutenstein mechanics are exposed publicly.",
        ],
        expected_result: {
          th: "เว็บไซต์มีความพร้อมต่อ Google, AI Search และการแชร์มากขึ้น",
          en: "The website becomes more discoverable by Google, AI search engines, and social sharing surfaces.",
        },
      });
    });
  });
  actions.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));

  return {
    version: "1.0",
    scan_id: scan.scan_id || `aimark-${Date.now()}`,
    client_url: scan.url || "",
    generated_at: new Date().toISOString(),
    package_required: true,
    package_name: "AI Mark Website Improvement Package",
    export_allowed: permission.allowed,
    export_reason: permission.reason,
    overall_score: Number(scan.overall || 0),
    grade: scan.grade || "",
    executive_summary: {
      th: scan.summary || "AI Mark พบโอกาสในการปรับปรุงเว็บไซต์เพื่อเพิ่มการมองเห็นบน Google และ AI Search",
      en: scan.summary || "AI Mark found opportunities to improve website visibility across Google and AI Search.",
    },
    priority_actions: actions.slice(0, 20),
    blutenstein_positioning: {
      public_copy_rule: "Keep the client brand first. Blutenstein appears only as a subtle trust/verification layer where appropriate.",
      footer_or_badge: "AI Mark by Blutenstein",
      avoid: [
        "Do not expose internal growth system mechanics.",
        "Do not expose private lead scoring.",
        "Do not overpromise instant Google or AI ranking.",
      ],
    },
    next_step_cta: {
      th: "ให้ AI Mark ปรับปรุงเว็บของคุณด้วยแพ็กเกจ Action Plan ฉบับเต็ม",
      en: "Let AI Mark improve your website with the full action package.",
    },
  };
}

function buildAgentPrompt(actionJson) {
  return `You are an expert production web engineer and AI visibility strategist.\n\nMission:\nImprove this website using the AI Mark Website Improvement Package.\n\nClient URL:\n${actionJson.client_url}\n\nOverall score:\n${actionJson.overall_score}/100, grade ${actionJson.grade}\n\nExecutive summary:\n${actionJson.executive_summary.en}\n\nRules:\n- Preserve the client brand and visual quality.\n- Improve Google SEO, AI Search/GEO-AEO readiness, crawler access, Open Graph/social sharing, and technical trust.\n- Do not expose API keys, internal notes, private Blutenstein mechanics, lead scoring, or credentials.\n- Do not overpromise instant Google or AI ranking.\n- Verify the live website after every deployment.\n- Keep Blutenstein/AI Mark as a subtle trust layer only where appropriate.\n\nPriority actions:\n${actionJson.priority_actions.map((a, i) => `${i + 1}. [${a.severity.toUpperCase()} / impact ${a.impact} / effort ${a.effort}] ${a.title.en}\n   Problem: ${a.problem.en}\n   Fix: ${a.recommended_fix.en}\n   AI instruction: ${a.ai_agent_instruction}\n   Verify: ${a.verification.join("; ")}`).join("\n\n")}\n\nFinal deliverable:\n- Implement the safest high-impact fixes first.\n- Run local checks.\n- Deploy.\n- Verify in browser and via HTTP/API where relevant.\n- Report files changed, deployment URL, before/after evidence, and remaining limitations.`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const status = await paidStatus(request, env, "locked");
  const permission = { allowed: status.paid, reason: status.reason };
  if (!permission.allowed) {
    return json({
      error: "Paid package required to export.",
      upgrade_required: true,
      allowed_preview: true,
      package_name: "AI Mark Website Improvement Package",
      cta: {
        en: "Let AI Mark improve my website",
        th: "ให้ AI Mark ปรับปรุงเว็บของฉัน",
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
  const type = String(payload.type || "bundle").toLowerCase();
  let creditCharge = null;
  if (status.reason === "credit_balance") {
    creditCharge = await consumeCredits(request, env, {
      feature: "export_package",
      amount: creditCost("export_package"),
      idempotency_key: `export_package:${scan.url || payload.url || "site"}:${type}`,
      metadata: { url: scan.url || payload.url || "", type },
    });
    if (!creditCharge.ok) {
      return json({
        error: creditCharge.error || "credit_debit_failed",
        upgrade_required: true,
        checkout_url: creditCharge.checkout_url || "/?modal=credits",
        credits_required: creditCharge.amount || creditCost("export_package"),
        credits_balance: creditCharge.balance ?? null,
        credits_needed: creditCharge.needed ?? null,
      }, 402);
    }
  }
  const actionJson = buildActionJson(scan, permission);
  actionJson.credit_charge = creditCharge;

  if (type === "action_json") return json(actionJson);
  if (type === "agent_prompt") return json({
    export_allowed: true,
    export_reason: permission.reason,
    credit_charge: creditCharge,
    package_name: actionJson.package_name,
    client_url: actionJson.client_url,
    prompt: buildAgentPrompt(actionJson),
  });

  return json({
    export_allowed: true,
    export_reason: permission.reason,
    credit_charge: creditCharge,
    package_name: actionJson.package_name,
    action_json: actionJson,
    agent_prompt: buildAgentPrompt(actionJson),
  });
}
