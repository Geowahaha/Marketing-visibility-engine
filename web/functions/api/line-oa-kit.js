/**
 * Cloudflare Pages Function — POST /api/line-oa-kit
 * ------------------------------------------------------------------
 * Thai conversion layer for AI Mark. Generates a LINE OA Growth Kit that can
 * be applied manually in LINE OA Manager or handed to a local MCP agent.
 *
 * Security guardrail: never ask for LINE channel tokens in AI Mark web UI.
 */

import { paidStatus } from "./_auth.js";
import { consumeCredits, creditCost } from "./_credits.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function normalizeUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

function brandFrom(url, payload) {
  const explicit = String(payload.business || payload.brand || payload.scan?.business || "").trim();
  if (explicit) return explicit.slice(0, 80);
  const host = hostOf(url);
  return (host.split(".")[0] || "ธุรกิจของคุณ").replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()).slice(0, 80);
}

function summaryFrom(brand, payload, lang) {
  const s = String(payload.summary || payload.scan?.summary || payload.scan?.business_summary || "").trim();
  if (s) return s.slice(0, 260);
  return lang === "th"
    ? `${brand} ต้องการเปลี่ยนผู้เข้าชมเว็บและโซเชียลให้กลายเป็นแชต ขอใบเสนอราคา และลูกค้าซื้อซ้ำผ่าน LINE OA`
    : `${brand} needs to convert website and social traffic into LINE chats, quote requests, and repeat customers.`;
}

function socialIdeas(payload, brand, lang) {
  const raw = payload.social_calendar?.calendar || payload.social_calendar || payload.improve?.artifacts?.social_calendar?.calendar || [];
  const usable = Array.isArray(raw) ? raw.filter((x) => x && (x.post || x.hook || x.topic)).slice(0, 6) : [];
  if (usable.length) return usable;
  const th = lang === "th";
  return [
    { day: 1, hook: th ? "ลูกค้าใหม่เริ่มจากตรงนี้" : "Start here", post: th ? `สรุปบริการหลักของ ${brand} และชวนทักเพื่อประเมินงานฟรี` : `Summarize ${brand}'s core service and invite a free quote.` },
    { day: 3, hook: th ? "เคสจริง/ผลงาน" : "Proof", post: th ? "แชร์ปัญหาลูกค้าก่อน-หลัง พร้อม CTA ให้ส่งรายละเอียดงาน" : "Share a before-after customer story with a CTA to send details." },
    { day: 7, hook: th ? "คำถามที่พบบ่อย" : "FAQ", post: th ? "ตอบ 3 คำถามที่ลูกค้าถามก่อนตัดสินใจ" : "Answer 3 buyer questions before they decide." },
    { day: 14, hook: th ? "โปรโมชันนุ่ม ๆ" : "Soft offer", post: th ? "ให้สิทธิ์ตรวจ/ปรึกษาเบื้องต้นสำหรับคนที่ทักในสัปดาห์นี้" : "Offer a light consult/check for people who message this week." },
    { day: 21, hook: th ? "รีวิว/ความน่าเชื่อถือ" : "Trust", post: th ? "รวมรีวิวหรือหลักฐานความน่าเชื่อถือ แล้วชวนถามราคา" : "Show reviews/trust proof and invite quote requests." },
    { day: 30, hook: th ? "ติดตามลูกค้าเก่า" : "Retention", post: th ? "ชวนลูกค้าเก่ากลับมาตรวจงาน/ใช้บริการซ้ำ" : "Invite past customers to review needs or buy again." },
  ];
}

function buildKit({ url, brand, summary, lang, payload, paid }) {
  const th = lang === "th";
  const labels = th
    ? ["บริการ", "ขอใบเสนอราคา", "ผลงาน/รีวิว", "คำถาม", "โปรโมชัน", "ติดต่อทีม"]
    : ["Services", "Quote", "Work/Reviews", "FAQ", "Promo", "Talk to team"];
  const quickReplies = th
    ? ["ขอใบเสนอราคา", "ดูบริการ", "ส่งรูป/รายละเอียดงาน", "คุยกับทีมงาน", "ดูผลงาน", "รับโปรโมชัน"]
    : ["Request quote", "View services", "Send details/photos", "Talk to team", "View work", "Get promo"];
  const ideas = socialIdeas(payload, brand, lang);
  const broadcasts = ideas.slice(0, paid ? 6 : 2).map((item, index) => ({
    day: item.day || index + 1,
    mode: "draft",
    dry_run_required: true,
    target: {
      everyone: false,
      note: th ? "เริ่มจากกลุ่มลูกค้า/คนที่เคยทัก ไม่ broadcast ทั้งหมดจนกว่า owner approve" : "Start with engaged users; do not broadcast-all until owner approval.",
    },
    message: {
      text: `${item.hook || brand}\n\n${item.post || summary}\n\n${th ? "ทัก LINE เพื่อปรึกษา/ขอราคา" : "Message us on LINE for advice or a quote"}: ${url}`,
    },
    line_mcp_tool: "line_send_message",
  }));
  const kit = {
    status: paid ? "full" : "preview",
    product: "LINE OA Growth Kit",
    source_url: url,
    brand,
    purpose: th
      ? "เปลี่ยนทราฟฟิกจากเว็บ/Google/AI/social ให้กลายเป็นแชต ขอราคา ติดตาม และซื้อซ้ำใน LINE OA"
      : "Convert website, Google, AI, and social traffic into LINE chats, quote requests, follow-up, and repeat purchases.",
    security_policy: th
      ? "AI Mark ไม่ขอ LINE token บนหน้าเว็บ ให้เก็บ token ใน LINE OA Manager หรือ local MCP config เท่านั้น"
      : "AI Mark does not ask for LINE tokens in the web UI. Keep tokens inside LINE OA Manager or local MCP config only.",
    manual_lane: [
      th ? "เปิด LINE Official Account Manager" : "Open LINE Official Account Manager.",
      th ? "ตั้ง greeting/welcome message จากชุดข้อความนี้" : "Set the greeting/welcome message from this kit.",
      th ? "สร้าง rich menu 6 ช่องตาม brief" : "Create the six-area rich menu from the brief.",
      th ? "เพิ่ม auto-reply/quick replies สำหรับ quote, service, contact" : "Add auto-replies/quick replies for quote, service, and contact intents.",
      th ? "บันทึก broadcast เป็น draft ก่อนส่งจริง" : "Save broadcasts as drafts before real sending.",
    ],
    mcp_lane: {
      package: "line-oa-mcp-ultimate",
      source: "https://github.com/Geowahaha/line-oa-mcp-ultimate.git",
      install: "npx -y line-oa-mcp-ultimate",
      secret_location: "~/.line-mcp/config.json or the owner's local MCP config",
      required_first_tools: ["line_get_oa_status", "line_list_rich_menus"],
      safety: "Use dry_run for outbound messages and require owner approval before any real broadcast.",
    },
    rich_menu: {
      tool: "line_build_rich_menu",
      name: `${brand} AI Mark Growth Menu`,
      size: "2500x1686",
      chat_bar_text: th ? "เมนูหลัก" : "Main menu",
      image_brief: th
        ? `ออกแบบ Rich Menu 6 ช่องสำหรับ ${brand}: ตัวอักษรใหญ่ อ่านง่ายบนมือถือ มี CTA ขอราคาและติดต่อทีมชัดเจน`
        : `Design a six-area rich menu for ${brand}: large readable mobile text with clear quote and contact CTAs.`,
      areas: labels.map((label, i) => ({
        label,
        action: i === 5 ? { type: "uri", uri: url } : { type: "message", text: th ? `สนใจ${label}` : `Interested in ${label}` },
      })),
    },
    welcome_message: th
      ? `สวัสดีครับ ยินดีต้อนรับสู่ ${brand}\n\nบอกได้เลยว่าคุณสนใจบริการไหน หรือต้องการใบเสนอราคา ทีมงานจะช่วยดูรายละเอียดและแนะนำขั้นตอนต่อไปให้ครับ\n\nเริ่มจากเมนูด้านล่าง หรือพิมพ์คำถามมาได้เลย`
      : `Hi, welcome to ${brand}.\n\nTell us which service you need or ask for a quote. The team will review your details and suggest the next step.\n\nStart from the menu below or type your question here.`,
    quick_replies: quickReplies,
    auto_reply_rules: [
      {
        intent: th ? "ขอราคา/ใบเสนอราคา" : "quote request",
        trigger_examples: th ? ["ราคา", "ขอราคา", "ใบเสนอราคา", "ประเมิน"] : ["price", "quote", "estimate"],
        reply: th ? `ส่งรายละเอียดงานหรือรูปมาได้เลยครับ ทีม ${brand} จะดูข้อมูลและแนะนำขั้นตอนต่อไปให้` : `Send project details or photos. ${brand} will review them and suggest next steps.`,
      },
      {
        intent: th ? "ถามบริการ" : "service question",
        trigger_examples: th ? ["บริการ", "ทำอะไร", "รับงานไหม"] : ["service", "what do you do", "can you help"],
        reply: summary,
      },
      {
        intent: th ? "ขอคุยกับคน" : "human handoff",
        trigger_examples: th ? ["แอดมิน", "คุยกับคน", "โทร"] : ["admin", "human", "call"],
        reply: th ? "รับทราบครับ ทีมงานจะติดต่อกลับ โปรดฝากชื่อ เบอร์โทร และรายละเอียดที่ต้องการให้ช่วย" : "Got it. Please leave your name, phone, and what you need help with.",
      },
    ],
    broadcast_drafts: broadcasts,
    coupon_retention: [
      {
        name: th ? "Quote follow-up" : "Quote follow-up",
        idea: th ? "ลูกค้าที่ขอราคาแต่ยังไม่ตัดสินใจ: ส่ง reminder + ตัวอย่างงาน + สิทธิ์ปรึกษาเพิ่ม" : "For quote leads who have not decided: send reminder + proof + extra consult offer.",
      },
      {
        name: th ? "Review loop" : "Review loop",
        idea: th ? "หลังปิดงาน: ขอรีวิว/รูปผลงาน แล้วใช้เป็น proof ในเว็บและ LINE" : "After delivery: request review/photos and reuse as proof on website and LINE.",
      },
      {
        name: th ? "Dormant customer" : "Dormant customer",
        idea: th ? "ลูกค้าเก่า 60-90 วัน: ส่งเช็คอินพร้อมข้อเสนอเล็ก ๆ หรือบริการเสริม" : "Past customers 60-90 days: send a check-in with a light offer or add-on service.",
      },
    ],
    verification_checklist: [
      "line_get_oa_status",
      "line_list_rich_menus",
      "rich menu visual preview approved by owner",
      "welcome message tested with a private test user",
      "broadcast dry_run completed",
      "owner approval recorded before any real send",
    ],
    agent_handoff: {
      kind: "line_oa_growth_kit",
      local_mcp: "line-oa-mcp-ultimate",
      prompt: `Set up LINE OA conversion for ${brand}. Use this kit as the brief. First inspect OA status and existing rich menus. Create drafts and dry-run outbound messages only. Never ask AI Mark web chat for LINE tokens; use the owner's local MCP config.`,
    },
    locked_fields: paid ? [] : ["broadcast_drafts_after_day_2", "agent_handoff_execution", "coupon_reporting"],
  };
  return kit;
}

function markdownFromKit(kit, lang) {
  const th = lang === "th";
  return `# ${kit.product} — ${kit.brand}

Source: ${kit.source_url}

## Purpose
${kit.purpose}

## Security
${kit.security_policy}

## Rich Menu
- Name: ${kit.rich_menu.name}
- Size: ${kit.rich_menu.size}
- Image brief: ${kit.rich_menu.image_brief}

${kit.rich_menu.areas.map((a, i) => `${i + 1}. ${a.label} -> ${a.action.type}: ${a.action.text || a.action.uri}`).join("\n")}

## Welcome Message
${kit.welcome_message}

## Quick Replies
${kit.quick_replies.map((q) => `- ${q}`).join("\n")}

## Auto Reply Rules
${kit.auto_reply_rules.map((r) => `- ${r.intent}: ${r.trigger_examples.join(", ")}\n  Reply: ${r.reply}`).join("\n")}

## Broadcast Drafts
${kit.broadcast_drafts.map((d) => `- Day ${d.day}: ${d.message.text.replace(/\n+/g, " / ")}`).join("\n")}

## Coupon / Retention
${kit.coupon_retention.map((c) => `- ${c.name}: ${c.idea}`).join("\n")}

## MCP Handoff
Package: ${kit.mcp_lane.package}
Install: ${kit.mcp_lane.install}
Secrets: ${kit.mcp_lane.secret_location}

Prompt:
${kit.agent_handoff.prompt}

## Verification
${kit.verification_checklist.map((x) => `- ${x}`).join("\n")}

${kit.status === "preview" ? (th ? "\nPreview เท่านั้น: เติมเครดิตเพื่อปลดล็อก broadcast ครบชุดและ agent handoff execution.\n" : "\nPreview only: add credits to unlock the full broadcast set and agent handoff execution.\n") : ""}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const url = normalizeUrl(payload.url || payload.scan?.url || "");
  if (!url) return json({ error: "Provide a URL." }, 400);
  const lang = payload.lang === "en" ? "en" : "th";
  const status = await paidStatus(request, env, "line_preview");
  const brand = brandFrom(url, payload);
  const summary = summaryFrom(brand, payload, lang);
  let creditCharge = null;
  if (status.paid && status.reason === "credit_balance") {
    creditCharge = await consumeCredits(request, env, {
      feature: "line_oa_growth_kit",
      amount: creditCost("line_oa_growth_kit"),
      idempotency_key: `line_oa_growth_kit:${hostOf(url) || url}`,
      metadata: { url, brand },
    });
    if (!creditCharge.ok) {
      return json({
        error: creditCharge.error || "credit_debit_failed",
        upgrade_required: true,
        checkout_url: creditCharge.checkout_url || "/?modal=credits",
        credits_required: creditCharge.amount || creditCost("line_oa_growth_kit"),
        credits_balance: creditCharge.balance ?? null,
        credits_needed: creditCharge.needed ?? null,
      }, 402);
    }
  }
  const kit = buildKit({ url, brand, summary, lang, payload, paid: status.paid });
  const markdown = markdownFromKit(kit, lang);
  const out = {
    url,
    brand,
    paid: status.paid,
    status: kit.status,
    paid_reason: status.reason,
    credit_charge: creditCharge,
    kit,
    markdown,
    honest_note: "AI Mark generates a safe LINE OA setup brief and local MCP handoff. It does not store LINE channel tokens in the web app and does not send broadcasts without owner approval.",
  };
  if (!status.paid) {
    out.upgrade = {
      required: true,
      checkout_url: "/?modal=credits",
      cta: lang === "th" ? "เติมเครดิตเพื่อปลดล็อก LINE OA Growth Kit เต็มชุด" : "Add credits to unlock the full LINE OA Growth Kit.",
    };
  }
  return json(out);
}
