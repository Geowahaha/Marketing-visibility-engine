/**
 * Cloudflare Pages Function — POST /api/improve  (the Improve Engine)
 * ------------------------------------------------------------------
 * The step that makes AI Mark more than a scanner. It takes a completed
 * scan (from /api/scan) + the live page, and uses Claude to GENERATE the
 * actual, copy-paste / deployable fixes a non-technical owner can apply:
 *
 *   1. head_block       – optimized <head>: title, description, canonical,
 *                         lang, viewport, full Open Graph + Twitter card
 *   2. json_ld          – Organization/LocalBusiness + FAQPage schema
 *   3. robots_txt       – AI-crawler-friendly robots.txt (+ sitemap line)
 *   4. llms_txt         – llms.txt content map for AI engines
 *   5. faq_block        – AEO answer/FAQ HTML block (biggest AI-citation lever)
 *   6. social_calendar  – 30-day, per-platform content calendar from real services
 *   7. line_oa_growth_kit – Thai-first LINE OA setup pack + MCP handoff brief
 *
 * Each artifact ships with what it fixes, where to paste it, and how to verify.
 *
 * Monetization: the free tier returns ONLY the head_block as a preview; the
 * paid tier (same gating as export-package.js) unlocks all generated artifacts
 * + the bundle.
 *
 * Env:
 *   ANTHROPIC_API_KEY  (required)
 *   CLAUDE_MODEL       (optional, default claude-sonnet-4-6)
 *   PAID_EXPORT_SECRET (optional — unlocks full artifacts via token/cookie)
 *   RATE_LIMIT_BYPASS_IPS / EXPORT_BYPASS_IPS (optional tester IPs)
 */

import { callLLM } from "./_llm.js";
import { paidStatus } from "./_auth.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 VisibilityEngine/1.0";

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

async function tryFetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "th,en;q=0.9" },
      redirect: "follow", signal: ctrl.signal, cf: { cacheTtl: 0 },
    });
    return { status: r.status, ok: r.ok, body: await r.text(), finalUrl: r.url };
  } catch (e) {
    return { status: 0, ok: false, body: "", error: String(e), finalUrl: url };
  } finally {
    clearTimeout(t);
  }
}

/** Minimal, dependency-free facts so Claude tailors artifacts to the real page. */
function extractFacts(html) {
  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ""; };
  const metaName = (n) =>
    pick(new RegExp(`<meta[^>]+name=["']${n}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${n}["']`, "i"));
  const metaProp = (p) =>
    pick(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${p}["']`, "i"));
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 12);
  const lang = pick(/<html[^>]+lang=["']([^"']*)["']/i);
  const textOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title,
    h1: h1s.slice(0, 5),
    h2: h2s,
    lang: lang || "",
    metaDescription: metaName("description"),
    og: { title: metaProp("og:title"), description: metaProp("og:description"), image: metaProp("og:image"), site_name: metaProp("og:site_name") },
    textSample: textOnly.slice(0, 3500),
  };
}

const SYSTEM_PROMPT = `You are the AI Mark Improve Engine: a senior production web engineer + GEO/AEO (AI-search) specialist working to 2026 standards. You receive (a) a finished visibility scan and (b) facts extracted from the live homepage. Your job is to GENERATE the actual, ready-to-use fixes — not advice. A non-technical business owner will paste these in, so everything must be complete, correct, and self-contained.

Detect the page's primary language from the facts (Thai or English). Write all human-facing copy (title, descriptions, OG text, FAQ questions/answers, social posts) in THAT language. Keep code/markup (tags, keys, robots directives) in English.

Return ONLY a JSON object (no markdown, no code fences, no prose) matching exactly:
{
 "url": string,
 "language": "th"|"en",
 "business_summary": string,            // 1-2 sentence neutral description you inferred
 "artifacts": {
   "head_block":   {"what_it_fixes": string, "where_to_paste": string, "verify": string, "code": string},
   "json_ld":      {"what_it_fixes": string, "where_to_paste": string, "verify": string, "code": string},
   "robots_txt":   {"what_it_fixes": string, "where_to_paste": string, "verify": string, "code": string},
   "llms_txt":     {"what_it_fixes": string, "where_to_paste": string, "verify": string, "code": string},
   "faq_block":    {"what_it_fixes": string, "where_to_paste": string, "verify": string, "code": string},
   "social_calendar": {"what_it_fixes": string, "where_to_paste": string, "verify": string, "calendar": [{"day": integer, "platform": string, "hook": string, "post": string, "cta": string}]},
   "line_oa_growth_kit": {"what_it_fixes": string, "where_to_paste": string, "verify": string, "code": string}
 },
 "expected_impact": string              // honest, no guarantees
}

Rules for each artifact:
- head_block.code: a full <head> snippet — <title> (<=60 chars, includes the brand + main keyword), meta description (140-160 chars, benefit + location), <meta name="viewport">, <link rel="canonical" href="<the real url>">, og:title/og:description/og:image/og:url/og:type/og:site_name/og:locale, twitter:card=summary_large_image + twitter:title/description/image. Use real values inferred from the facts; if og:image is unknown, use the page's URL origin + "/og-image.jpg" and note it in where_to_paste.
- json_ld.code: one <script type="application/ld+json"> with an Organization or LocalBusiness object (name, url, description, and address/areaServed if location is evident) AND a FAQPage object with 3-5 Q&As a real buyer would ask. Valid JSON inside the script.
- robots_txt.code: explicitly Allow GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, Googlebot, Bingbot; a generic User-agent: * Allow: /; and a Sitemap: <origin>/sitemap.xml line.
- llms_txt.code: a Markdown llms.txt — "# <Brand>", one-line summary, "## Key pages" with the homepage and likely service/contact paths, "## Services", "## Contact". Keep it factual to what the site shows.
- faq_block.code: an HTML section with 4-6 buyer questions, each answered in 2-4 sentences leading with the direct answer (AEO style), wrapped so it can be pasted into the page body. This is the single biggest AI-citation lever — make answers genuinely useful and citation-worthy.
- social_calendar.calendar: 30 entries (day 1-30) cycling the platforms the business plausibly uses (Facebook, Instagram, TikTok, YouTube/Shorts, LINE OA), each a concrete post idea derived from the site's REAL services, not generic filler.
- line_oa_growth_kit.code: a Markdown setup brief that turns the website fixes into a Thai-first LINE OA conversion layer: rich menu layout, welcome message, quick replies, 3-6 draft broadcasts derived from social_calendar, auto-reply rules, and an agent handoff prompt for the open-source package line-oa-mcp-ultimate. Security requirement: never ask the customer to paste a LINE channel token into AI Mark's web UI; instruct them to keep LINE secrets inside local MCP config or LINE's own manager.

Be specific to this business. Do not invent fake awards, fake numbers, fake reviews, fake addresses, or guarantee Google/AI ranking. If a fact is unknown, use a clearly-labeled placeholder the owner can fill (e.g. "[เบอร์โทร]" / "[phone]").`;

function extractJson(text) {
  let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callClaude(env, messages, maxTokens = 8000) {
  // Delegates to the shared multi-provider caller (Anthropic → Groq → Kimi).
  const r = await callLLM(env, { system: SYSTEM_PROMPT, messages, maxTokens, temperature: 0 });
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail, status: r.status || 502 };
  return { ok: true, text: r.text, provider: r.provider };
}

const LOCKED = (label) => ({
  locked: true,
  upgrade_required: true,
  preview_note: {
    en: `${label} is generated and ready. Unlock the full Fix Pack to copy/deploy it.`,
    th: `สร้าง ${label} เสร็จแล้ว ปลดล็อกแพ็กเกจ Fix Pack เพื่อคัดลอก/นำไปใช้`,
  },
});

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function hasThai(value) {
  return /[\u0E00-\u0E7F]/.test(String(value || ""));
}

function urlOrigin(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

function brandFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return (host.split(".")[0] || "Brand").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "Brand";
  }
}

function deriveBrand(url, facts) {
  const raw =
    facts?.og?.site_name ||
    facts?.og?.title ||
    (Array.isArray(facts?.h1) && facts.h1[0]) ||
    facts?.title ||
    brandFromUrl(url);
  const clean = stripTags(raw).split(/\s+[|–—-]\s+/)[0].trim();
  return clean.slice(0, 70) || brandFromUrl(url);
}

function deriveSummary(facts, brand, lang) {
  const sample = stripTags(facts?.metaDescription || facts?.og?.description || facts?.textSample || "");
  if (sample) return sample.slice(0, 220);
  return lang === "th"
    ? `${brand} ให้บริการผ่านเว็บไซต์นี้ พร้อมข้อมูลที่ควรจัดโครงสร้างให้ Google และ AI อ่านได้ชัดขึ้น`
    : `${brand} presents its services on this website and should structure the page so Google and AI answer engines can read it clearly.`;
}

function metaDescription(summary, brand, lang) {
  const base = summary.length > 80 ? summary : (
    lang === "th"
      ? `${brand} ให้บริการด้วยข้อมูลชัดเจนสำหรับลูกค้า พร้อมปรับโครงสร้างเว็บให้ Google และ AI อ่าน เข้าใจ และแนะนำได้ง่ายขึ้น`
      : `${brand} helps customers understand its services with clearer website structure for Google, AI search engines, and social sharing.`
  );
  return base.replace(/\s+/g, " ").slice(0, 158);
}

function fallbackFaq(lang, brand) {
  if (lang === "th") {
    return [
      [`${brand} ให้บริการอะไร?`, `${brand} ให้บริการตามข้อมูลที่แสดงบนเว็บไซต์ โดยควรสรุปบริการหลัก ลูกค้าที่เหมาะสม และช่องทางติดต่อไว้ในย่อหน้าแรกเพื่อให้คนและ AI เข้าใจทันที`],
      [`ทำไมเว็บไซต์ควรมี FAQ สำหรับ AI Search?`, `FAQ ช่วยให้ Google, ChatGPT, Perplexity และเครื่องมือค้นหาด้วย AI ดึงคำตอบไปอ้างอิงได้ง่ายขึ้น เพราะคำถามและคำตอบมีโครงสร้างตรงกับสิ่งที่ลูกค้าค้นหา`],
      [`ลูกค้าควรติดต่ออย่างไร?`, `ควรวางเบอร์โทร LINE อีเมล หรือแบบฟอร์มติดต่อไว้ใกล้ส่วนบนของหน้า และใส่ข้อมูลเดียวกันใน schema เพื่อให้เครื่องมือค้นหาเข้าใจช่องทางติดต่อที่ถูกต้อง`],
      [`ควรปรับอะไรเป็นอันดับแรก?`, `เริ่มจาก title, meta description, Open Graph, schema, robots.txt, llms.txt และบล็อก FAQ เพราะเป็นชุดแก้ที่มีผลกับการอ่านของ Google, AI crawler และการแชร์บนโซเชียลพร้อมกัน`],
    ];
  }
  return [
    [`What does ${brand} do?`, `${brand} provides the services described on this website. The first page section should clearly state the offer, who it helps, where it operates, and how a buyer can contact the business.`],
    ["Why add an FAQ for AI search?", "FAQ content gives Google, ChatGPT, Perplexity, and other answer engines direct question-and-answer blocks they can parse, summarize, and cite more easily."],
    ["How should customers contact the business?", "Place the phone, LINE, email, or contact form near the top of the page, then repeat the same contact details in structured data so search engines understand the official conversion path."],
    ["What should be fixed first?", "Start with the title, meta description, Open Graph tags, schema, robots.txt, llms.txt, and an answer-led FAQ block because those fixes help Google, AI crawlers, and social previews at the same time."],
  ];
}

function fallbackSocialCalendar(lang, brand) {
  const platforms = ["Facebook", "Instagram", "TikTok", "YouTube Shorts", "LINE OA"];
  const themes = lang === "th"
    ? [
        ["ปัญหาลูกค้า", "เล่าปัญหาที่ลูกค้ามักเจอก่อนเลือกผู้ให้บริการ", "ทัก LINE เพื่อปรึกษา"],
        ["เบื้องหลัง", "พาเห็นขั้นตอนทำงานจริงและมาตรฐานที่ใช้", "ขอใบเสนอราคา"],
        ["คำถามยอดฮิต", "ตอบคำถามที่คนค้นหาก่อนตัดสินใจซื้อ", "ส่งรายละเอียดงาน"],
        ["ผลงาน/ตัวอย่าง", "โชว์ตัวอย่างงานหรือกรณีใช้งานโดยไม่อ้างตัวเลขเกินจริง", "ดูบริการเพิ่มเติม"],
        ["ความน่าเชื่อถือ", "อธิบายวิธีตรวจคุณภาพ ระยะเวลา และสิ่งที่ลูกค้าต้องเตรียม", "นัดคุย"],
      ]
    : [
        ["Buyer pain", "Explain the problem customers usually face before choosing a provider.", "Message us for advice"],
        ["Behind the work", "Show the real process and quality checks behind the service.", "Request a quote"],
        ["Common question", "Answer a buyer question people search before they contact you.", "Send your project details"],
        ["Example use case", "Show a realistic project example without inventing numbers or testimonials.", "View services"],
        ["Trust signal", "Explain quality control, lead time, and what customers should prepare.", "Book a consultation"],
      ];
  const calendar = [];
  for (let i = 1; i <= 30; i++) {
    const platform = platforms[(i - 1) % platforms.length];
    const theme = themes[(i - 1) % themes.length];
    calendar.push({
      day: i,
      platform,
      hook: `${brand}: ${theme[0]}`,
      post: lang === "th"
        ? `${theme[1]} ปิดท้ายด้วยคำตอบสั้น ๆ ว่า ${brand} ช่วยลูกค้าเรื่องนี้อย่างไร`
        : `${theme[1]} End with one clear line on how ${brand} helps with this.`,
      cta: theme[2],
    });
  }
  return calendar;
}

function buildLineOaGrowthKit(lang, brand, url, summary, socialCalendar = []) {
  const isThai = lang === "th";
  const ctaLine = isThai ? "ทัก LINE เพื่อปรึกษา" : "Message us on LINE";
  const menuLabels = isThai
    ? ["บริการ", "ราคา/ใบเสนอราคา", "ผลงาน", "คำถาม", "โปรโมชัน", "ติดต่อ"]
    : ["Services", "Quote", "Work", "FAQ", "Promo", "Contact"];
  const welcome = isThai
    ? `สวัสดีครับ ยินดีต้อนรับสู่ ${brand} 🙏\n\nบอกผมได้เลยว่าคุณสนใจบริการไหน หรือต้องการใบเสนอราคา ทีมงานจะช่วยดูข้อมูลและแนะนำขั้นตอนต่อไปให้ครับ\n\nเริ่มได้ด้วยการกดเมนูด้านล่าง หรือพิมพ์คำถามมาได้เลย`
    : `Hi, welcome to ${brand}.\n\nTell us which service you are interested in or ask for a quote. The team will review your details and suggest the next step.\n\nStart from the menu below or type your question here.`;
  const broadcasts = (socialCalendar || [])
    .filter((item) => String(item.platform || "").toLowerCase().includes("line"))
    .slice(0, 6)
    .map((item, index) => ({
      day: item.day || index + 1,
      mode: "draft",
      target: { everyone: false, note: isThai ? "เริ่มจากกลุ่มลูกค้า/คนที่เคยทัก ไม่ broadcast ทั้งหมดจนกว่าจะ dry_run ผ่าน" : "Start with engaged customers; avoid broadcast-all until dry_run passes." },
      message: {
        text: `${item.hook || brand}\n\n${item.post || summary}\n\n${item.cta || ctaLine}: ${url}`,
      },
      line_mcp_tool: "line_send_message",
    }));
  const kit = {
    purpose: isThai
      ? "เปลี่ยน LINE OA จากช่องแชทเฉย ๆ ให้เป็น conversion assistant หลัง AI Mark แก้เว็บ"
      : "Turn LINE OA from a passive chat channel into a conversion assistant after AI Mark fixes the site.",
    source_url: url,
    customer_setup_policy: isThai
      ? "AI Mark ไม่ขอ LINE token บนหน้าเว็บ ลูกค้าติดตั้ง MCP บนเครื่องตัวเองหรือเครื่องทีม แล้วเก็บ token ใน local config"
      : "AI Mark does not ask for LINE tokens in the web app. The customer installs the MCP server locally and keeps tokens in local config.",
    mcp_server: {
      package: "line-oa-mcp-ultimate",
      source: "https://github.com/Geowahaha/line-oa-mcp-ultimate.git",
      install: "npx -y line-oa-mcp-ultimate",
      recommended_mode: "local stdio MCP for one OA; multi-OA config for agencies",
    },
    rich_menu: {
      tool: "line_build_rich_menu",
      name: `${brand} AI Mark Growth Menu`,
      chat_bar_text: isThai ? "เมนูหลัก" : "Main menu",
      size: "large",
      image_brief: isThai
        ? `ออกแบบ Rich Menu 2500x1686 สำหรับ ${brand}: 6 ช่องชัดเจน ใช้สีแบรนด์ อ่านง่ายบนมือถือ`
        : `Design a 2500x1686 rich menu for ${brand}: six clear tappable areas, brand colors, readable on mobile.`,
      areas: menuLabels.map((label, index) => ({
        label,
        action: index === 5
          ? { type: "uri", uri: url }
          : { type: "message", text: isThai ? `สนใจ${label}` : `I am interested in ${label}` },
      })),
    },
    welcome_message: welcome,
    quick_replies: isThai
      ? ["ขอใบเสนอราคา", "ดูบริการ", "ส่งรูป/รายละเอียดงาน", "คุยกับทีมงาน", "ดูผลงาน", "โปรโมชัน"]
      : ["Request a quote", "View services", "Send project details", "Talk to the team", "View work", "Promotions"],
    auto_reply_rules: [
      {
        intent: isThai ? "ขอราคา/ใบเสนอราคา" : "quote request",
        trigger_examples: isThai ? ["ราคา", "ขอราคา", "ใบเสนอราคา", "ประเมิน"] : ["price", "quote", "estimate"],
        reply: isThai
          ? `ส่งรายละเอียดงานหรือรูปมาได้เลยครับ ทีม ${brand} จะดูข้อมูลและแนะนำขั้นตอนต่อไปให้`
          : `Send your project details or photos. ${brand} will review them and suggest the next step.`,
      },
      {
        intent: isThai ? "ถามบริการ" : "service question",
        trigger_examples: isThai ? ["บริการ", "ทำอะไร", "รับงานไหม"] : ["service", "what do you do", "can you help"],
        reply: summary,
      },
    ],
    broadcast_drafts: broadcasts.length ? broadcasts : [
      {
        day: 1,
        mode: "draft",
        target: { everyone: false },
        message: { text: `${brand}\n\n${summary}\n\n${ctaLine}: ${url}` },
        line_mcp_tool: "line_send_message",
      },
    ],
    verification: [
      isThai ? "รัน line_get_oa_status เพื่อตรวจ quota/webhook/rich menu" : "Run line_get_oa_status to check quota/webhook/rich menu.",
      isThai ? "สร้างข้อความแบบ dry_run ก่อนส่งจริงทุกครั้ง" : "Use dry_run before every real send.",
      isThai ? "หลีกเลี่ยงส่งช่วง 22:00-08:00 เวลาไทย ยกเว้นลูกค้าร้องขอ" : "Avoid 22:00-08:00 Thailand time unless requested.",
      isThai ? "วัดผลด้วย line_get_message_stats หลังส่งอย่างน้อย 24 ชั่วโมง" : "Check line_get_message_stats at least 24 hours after sending.",
    ],
  };
  const markdown = `# LINE OA Growth Kit — ${brand}

## Mission
${kit.purpose}

## Security
${kit.customer_setup_policy}

## MCP Server
- Package: ${kit.mcp_server.package}
- Source: ${kit.mcp_server.source}
- Install: \`${kit.mcp_server.install}\`
- Mode: ${kit.mcp_server.recommended_mode}

## Rich Menu Brief
- Tool: \`${kit.rich_menu.tool}\`
- Name: ${kit.rich_menu.name}
- Chat bar: ${kit.rich_menu.chat_bar_text}
- Size: ${kit.rich_menu.size}
- Image brief: ${kit.rich_menu.image_brief}
- Areas: ${kit.rich_menu.areas.map((a) => `${a.label} -> ${a.action.type}`).join(", ")}

## Welcome Message
${kit.welcome_message}

## Quick Replies
${kit.quick_replies.map((x) => `- ${x}`).join("\n")}

## Broadcast Drafts
${kit.broadcast_drafts.map((d) => `- Day ${d.day}: ${d.message.text.replace(/\n+/g, " / ")}`).join("\n")}

## Agent Prompt For line-oa-mcp-ultimate
Use the LINE OA MCP tools to set up this customer's OA safely. First run \`line_get_oa_status\`, then create or update a rich menu, prepare the welcome/auto-reply copy as drafts, and run all outbound messages in \`dry_run\` before sending. Do not broadcast to everyone without explicit owner confirmation.
`;
  return { kit, markdown };
}

function buildFallbackImprove(url, facts, scan, reason = "") {
  const haystack = `${facts?.title || ""} ${facts?.metaDescription || ""} ${facts?.textSample || ""}`;
  const lang = hasThai(haystack) ? "th" : "en";
  const origin = urlOrigin(url);
  const brand = deriveBrand(url, facts);
  const summary = deriveSummary(facts, brand, lang);
  const desc = metaDescription(summary, brand, lang);
  const ogImage = facts?.og?.image || `${origin}/og-image.jpg`;
  const faq = fallbackFaq(lang, brand);
  const socialCalendar = fallbackSocialCalendar(lang, brand);
  const lineKit = buildLineOaGrowthKit(lang, brand, url, summary, socialCalendar);
  const title = lang === "th" ? `${brand} | บริการและข้อมูลสำหรับลูกค้า` : `${brand} | Services and Customer Information`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": `${origin}/#organization`, name: brand, url, description: desc },
      { "@type": "WebSite", "@id": `${origin}/#website`, name: brand, url: origin || url, publisher: { "@id": `${origin}/#organization` } },
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        mainEntity: faq.map(([q, a]) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };
  const faqHtml = `<section id="faq" class="aimark-faq">\n  <h2>${lang === "th" ? "คำถามที่พบบ่อย" : "Frequently Asked Questions"}</h2>\n` +
    faq.map(([q, a]) => `  <article>\n    <h3>${escapeHtml(q)}</h3>\n    <p>${escapeHtml(a)}</p>\n  </article>`).join("\n") +
    `\n</section>`;
  return {
    url,
    language: lang,
    business_summary: summary,
    fallback_generated: true,
    fallback_reason: reason || "llm_output_repaired_with_safe_artifacts",
    artifacts: {
      head_block: {
        what_it_fixes: lang === "th" ? "เพิ่ม title, meta, canonical, Open Graph และ Twitter Card ที่ครบถ้วน" : "Adds complete title, meta, canonical, Open Graph, and Twitter Card tags.",
        where_to_paste: lang === "th" ? "วางภายในแท็ก <head> ของหน้าเว็บหลัก แล้วปรับ og:image หากยังไม่มีรูปจริง" : "Paste inside the page <head>. Replace og:image if you do not yet have a real image.",
        verify: lang === "th" ? "เปิด View Source แล้วตรวจว่ามี title, description, canonical, og:image และ twitter:card" : "View source and confirm title, description, canonical, og:image, and twitter:card are present.",
        code: `<title>${escapeHtml(title.slice(0, 60))}</title>\n<meta name="description" content="${escapeAttr(desc)}">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="canonical" href="${escapeAttr(url)}">\n<meta property="og:title" content="${escapeAttr(title.slice(0, 70))}">\n<meta property="og:description" content="${escapeAttr(desc)}">\n<meta property="og:image" content="${escapeAttr(ogImage)}">\n<meta property="og:url" content="${escapeAttr(url)}">\n<meta property="og:type" content="website">\n<meta property="og:site_name" content="${escapeAttr(brand)}">\n<meta property="og:locale" content="${lang === "th" ? "th_TH" : "en_US"}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="${escapeAttr(title.slice(0, 70))}">\n<meta name="twitter:description" content="${escapeAttr(desc)}">\n<meta name="twitter:image" content="${escapeAttr(ogImage)}">`,
      },
      json_ld: {
        what_it_fixes: lang === "th" ? "เพิ่ม Organization/WebSite/FAQPage schema เพื่อให้เครื่องมือค้นหาเข้าใจธุรกิจและคำตอบหลัก" : "Adds Organization, WebSite, and FAQPage schema so search engines understand the business and its key answers.",
        where_to_paste: lang === "th" ? "วางก่อน </head>" : "Paste before </head>.",
        verify: "Test with Google Rich Results Test or Schema Markup Validator.",
        code: `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>`,
      },
      robots_txt: {
        what_it_fixes: lang === "th" ? "ทำให้ crawler หลักและ AI search bots อ่านเว็บได้" : "Allows major search crawlers and AI search bots to read the site.",
        where_to_paste: lang === "th" ? "อัปโหลดเป็น /robots.txt ที่ root ของเว็บไซต์" : "Upload as /robots.txt at the website root.",
        verify: `${origin}/robots.txt`,
        code: `User-agent: GPTBot\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: ChatGPT-User\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: Claude-SearchBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: Bingbot\nAllow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
      },
      llms_txt: {
        what_it_fixes: lang === "th" ? "เพิ่มแผนที่เนื้อหาให้ AI เข้าใจหน้าและบริการหลัก" : "Adds a concise content map for AI systems.",
        where_to_paste: lang === "th" ? "อัปโหลดเป็น /llms.txt ที่ root ของเว็บไซต์" : "Upload as /llms.txt at the website root.",
        verify: `${origin}/llms.txt`,
        code: `# ${brand}\n\n${summary}\n\n## Key pages\n- Home: ${url}\n- Services: ${origin}/services\n- Contact: ${origin}/contact\n\n## Services\n- Main services described on the website\n- Customer questions answered in the FAQ section\n\n## Contact\n- Website: ${url}\n- Add phone, LINE, email, and address here if available\n`,
      },
      faq_block: {
        what_it_fixes: lang === "th" ? "เพิ่มบล็อกคำตอบแบบ AEO ที่ AI สามารถอ่านและอ้างอิงได้ง่าย" : "Adds answer-led AEO content that AI systems can parse and cite more easily.",
        where_to_paste: lang === "th" ? "วางใน body ของหน้าแรกหรือหน้าบริการหลัก" : "Paste into the homepage or main service page body.",
        verify: lang === "th" ? "ตรวจว่าคำถามแสดงบนหน้าเว็บจริง ไม่ซ่อนเฉพาะใน schema" : "Confirm the questions are visible on the page, not hidden only in schema.",
        code: faqHtml,
      },
      social_calendar: {
        what_it_fixes: lang === "th" ? "ให้แผนโพสต์ 30 วันเพื่อเปลี่ยนการแก้เว็บเป็นทราฟฟิกและลีด" : "Gives a 30-day posting plan to turn the website fixes into traffic and leads.",
        where_to_paste: lang === "th" ? "ใช้เป็นปฏิทินโพสต์ใน Facebook, IG, TikTok, YouTube Shorts และ LINE OA" : "Use as a posting calendar for Facebook, IG, TikTok, YouTube Shorts, and LINE OA.",
        verify: lang === "th" ? "โพสต์พร้อม CTA และบันทึกวันที่/ช่องทางเพื่อเทียบผล" : "Publish with a CTA and track date/channel for before-after proof.",
        calendar: socialCalendar,
      },
      line_oa_growth_kit: {
        what_it_fixes: lang === "th" ? "เพิ่ม LINE OA conversion layer สำหรับลูกค้าไทยหลังแก้เว็บ" : "Adds a LINE OA conversion layer after the website fixes.",
        where_to_paste: lang === "th" ? "ส่งให้ agent ที่ติดตั้ง line-oa-mcp-ultimate หรือใช้เป็น brief ตั้งค่า LINE OA Manager" : "Send to an agent with line-oa-mcp-ultimate installed, or use as a LINE OA Manager setup brief.",
        verify: lang === "th" ? "ตรวจด้วย line_get_oa_status, line_list_rich_menus และ dry_run ก่อนส่งข้อความจริง" : "Verify with line_get_oa_status, line_list_rich_menus, and dry_run before any real send.",
        code: lineKit.markdown,
        kit: lineKit.kit,
      },
    },
    expected_impact: lang === "th"
      ? "ชุดแก้นี้ช่วยให้เว็บอ่านง่ายขึ้นสำหรับ Google, AI crawler และ social preview แต่ไม่รับประกันอันดับหรือการถูกอ้างอิง"
      : "These fixes improve readability for Google, AI crawlers, and social previews, but they do not guarantee rankings or AI citations.",
    _input_score: scan?.overall ?? null,
  };
}

function ensureCompleteImprove(improve, fallback) {
  const out = (improve && typeof improve === "object") ? { ...fallback, ...improve } : { ...fallback };
  const got = (improve && typeof improve.artifacts === "object") ? improve.artifacts : {};
  out.artifacts = { ...fallback.artifacts, ...got };
  for (const key of ["head_block", "json_ld", "robots_txt", "llms_txt", "faq_block"]) {
    if (!out.artifacts[key] || typeof out.artifacts[key].code !== "string" || !out.artifacts[key].code.trim()) {
      out.artifacts[key] = fallback.artifacts[key];
    }
  }
  const cal = out.artifacts.social_calendar?.calendar;
  if (!Array.isArray(cal) || cal.length < 30) {
    out.artifacts.social_calendar = fallback.artifacts.social_calendar;
  }
  if (!out.artifacts.line_oa_growth_kit || typeof out.artifacts.line_oa_growth_kit.code !== "string" || !out.artifacts.line_oa_growth_kit.code.trim()) {
    out.artifacts.line_oa_growth_kit = fallback.artifacts.line_oa_growth_kit;
  }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY && !env.KIMI_API_KEY) {
    return json({ error: "Server has no LLM key (set ANTHROPIC_API_KEY, GROQ_API_KEY, or KIMI_API_KEY)." }, 500);
  }

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const scan = payload.scan || payload || {};
  const url = normalizeUrl(payload.url || scan.url || "");
  if (!url) return json({ error: "Provide a scanned URL to improve." }, 400);

  const status = await paidStatus(request, env);

  // Pull the live homepage so artifacts are tailored to the real content.
  const home = await tryFetchText(url, 12000);
  const facts = home.ok ? extractFacts(home.body) : { note: "homepage_fetch_failed", title: scan.url || url };

  // Compact the scan to its actionable findings to keep the prompt tight.
  const findings = (Array.isArray(scan.categories) ? scan.categories : []).flatMap((c) =>
    (c.findings || [])
      .filter((f) => ["fail", "warn"].includes(String(f.status || "").toLowerCase()))
      .map((f) => ({ category: c.name, check: f.check, severity: f.severity, detail: f.detail, fix: f.fix }))
  ).slice(0, 25);

  const userBlock =
    `Generate the fix artifacts for this site.\n\n` +
    `URL: ${url}\n` +
    (payload.business ? `Business: ${payload.business}\n` : "") +
    (payload.contact ? `Contact: ${payload.contact}\n` : "") +
    `Scan overall: ${scan.overall ?? "?"}/100 grade ${scan.grade ?? "?"}\n\n` +
    `FINDINGS TO FIX:\n${JSON.stringify(findings, null, 2)}\n\n` +
    `LIVE PAGE FACTS:\n${JSON.stringify(facts, null, 2)}`;

  const out = await callClaude(env, [{ role: "user", content: userBlock }], 8000);
  const fallback = buildFallbackImprove(url, facts, scan);
  let improve = null;
  let repair = null;

  if (out.ok) {
    try {
      improve = extractJson(out.text);
    } catch {
      repair = await callClaude(env, [{
        role: "user",
        content:
          `The previous Improve Engine output was invalid or truncated JSON. ` +
          `Repair it into ONE complete valid JSON object matching the required schema. ` +
          `Keep artifacts concise, preserve the same site facts, include exactly 30 social_calendar entries, and include line_oa_growth_kit. ` +
          `Return JSON only.\n\nURL: ${url}\n\nFALLBACK SHAPE TO USE IF NEEDED:\n${JSON.stringify(fallback, null, 2)}\n\nBROKEN OUTPUT:\n${String(out.text || "").slice(0, 9000)}`,
      }], 12000);
      if (repair.ok) {
        try { improve = extractJson(repair.text); } catch { improve = null; }
      }
    }
  }

  if (!improve) {
    improve = buildFallbackImprove(url, facts, scan, out.ok ? "llm_json_parse_failed" : (out.error || "llm_call_failed"));
  }
  improve = ensureCompleteImprove(improve, fallback);
  improve.url = improve.url || url;
  improve.generated_at = new Date().toISOString();
  improve.paid = status.paid;
  improve.paid_reason = status.reason;
  improve._engine_provider = out.ok ? out.provider : null;
  if (repair?.ok) improve._repair_provider = repair.provider;
  if (!out.ok) improve._llm_error = out.detail ? { error: out.error, detail: out.detail } : { error: out.error };

  // Free preview: head_block stays visible to create the "aha"; the rest is locked
  // until the Fix Pack is purchased. Paid unlocks everything.
  if (!status.paid && improve.artifacts) {
    const a = improve.artifacts;
    const reveal = a.head_block; // the teaser they can actually use
    improve.artifacts = {
      head_block: reveal || LOCKED("Head / meta block"),
      json_ld: LOCKED("Schema (JSON-LD)"),
      robots_txt: LOCKED("AI robots.txt"),
      llms_txt: LOCKED("llms.txt"),
      faq_block: LOCKED("AI-answer FAQ block"),
      social_calendar: LOCKED("30-day social calendar"),
      line_oa_growth_kit: LOCKED("LINE OA Growth Kit"),
    };
    improve.upgrade = {
      required: true,
      product: "AI Mark Fix Pack",
      cta: {
        en: "Unlock all fixes and apply them to your site",
        th: "ปลดล็อกการแก้ไขทั้งหมดและนำไปใช้กับเว็บของคุณ",
      },
      checkout_url: "/api/checkout?product=starter",
    };
  }

  return json(improve);
}
