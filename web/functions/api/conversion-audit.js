/**
 * Cloudflare Pages Function — POST /api/conversion-audit
 * ------------------------------------------------------------------
 * The "where is my ad money leaking?" skill. SMEs pay for ads/LINE/Facebook
 * traffic, then send it to a landing page that does not convert. This audits
 * the PUBLIC landing page that receives paid traffic and scores conversion
 * readiness deterministically (same rubric every time, so it is trustworthy),
 * then — for paid users — adds a site-specific fix plan.
 *
 * It is honest: it can only see the public page, not the ad account. It never
 * claims to know real ad spend or conversion numbers without account access.
 *
 * Free  : deterministic conversion score + checks + top 3 leaks (lead magnet).
 * Paid  : full leak list + LLM-written, site-specific fix plan. Credits:
 *         "conversion_audit" (priced in the Hermes skill registry, _skills.js).
 *
 * Body: { url | html?, lang? }
 */

import { paidStatus } from "./_auth.js";
import { checkCreditBalance, consumeCredits, creditCost } from "./_credits.js";
import { callLLM } from "./_llm.js";
import { checkRateLimit, rl429 } from "./_ratelimit.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AI-Mark-ConversionAudit/1.0";

function normalizeUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}

function textOf(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countMatches(s, re) {
  const m = String(s || "").match(re);
  return m ? m.length : 0;
}

async function rawFetchHtml(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", cf: { cacheTtl: 0 } });
    if (!r.ok) return { html: "", error: `fetch_status_${r.status}` };
    return { html: await r.text(), error: "" };
  } catch (e) {
    return { html: "", error: String(e).slice(0, 160) };
  }
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch {}
  }
  return null;
}

function grade(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

const CTA_RE = /(ขอใบเสนอราคา|ใบเสนอราคา|สั่งซื้อ|สั่งทำ|ติดต่อเรา|ติดต่อ|สอบถาม|โทรเลย|แชทเลย|จองคิว|ลงทะเบียน|add to cart|buy now|order now|request a quote|get a quote|contact us|get started|book now|call now|sign up|shop now)/gi;
const TRUST_RE = /(ได้รับการรับรอง|รับรอง|มาตรฐาน|ISO\s?\d|รีวิว|ลูกค้าของเรา|ผลงาน|รับประกัน|ประสบการณ์|ก่อตั้ง|testimonial|reviews?|warranty|guarantee|certified|trusted by|years of experience|since\s+\d{4})/gi;
const TRACK_RE = /(googletagmanager\.com|gtag\(|google-analytics\.com|analytics\.js|fbq\(|connect\.facebook\.net|_linetag|line-tag|lineTag|ttq\.|tiktok[^<]{0,40}pixel|hotjar|clarity\.ms|matomo|plausible\.io)/i;

/**
 * Pure, deterministic conversion-readiness analysis. Exported for tests so the
 * scoring needs no network, LLM, or credits. Same input → same score.
 */
export function analyzeConversion(html, url = "", lang = "en") {
  const h = String(html || "");
  const text = textOf(h);
  const th = lang === "th";

  const h1m = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1text = h1m ? textOf(h1m[1]) : "";
  const hasAnchorOrBtn = /<a\s[^>]*href/i.test(h) || /<button/i.test(h);
  const ctaCount = countMatches(h, CTA_RE);
  const hasTel = /href=["']tel:/i.test(h);
  const hasMail = /href=["']mailto:/i.test(h);
  const hasForm = /<form[\s>]/i.test(h);
  const hasLine = /(line\.me|lin\.ee)/i.test(h);
  const trustCount = countMatches(h, TRUST_RE);
  const tracking = TRACK_RE.test(h);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(h);
  const allInputs = countMatches(h, /<input\b/gi);
  const hiddenInputs = countMatches(h, /<input\b[^>]*type=["']hidden["']/gi);
  const fields = Math.max(0, allInputs - hiddenInputs) + countMatches(h, /<select\b/gi) + countMatches(h, /<textarea\b/gi);
  const contentLen = text.length;
  const hasContactPath = hasTel || hasMail || hasForm || hasLine;

  const def = [
    {
      id: "value_prop", weight: 15,
      label: th ? "พาดหัวบอกคุณค่าชัดเจน" : "Clear value proposition (H1)",
      pass: !!h1text && h1text.length >= 12,
      detail: h1text ? `H1: "${h1text.slice(0, 80)}"` : "No usable H1 headline found.",
      fix: th ? "ใส่ H1 ที่บอกว่าคุณช่วยใครแก้ปัญหาอะไรภายในครึ่งบรรทัด" : "Add an H1 stating who you help and the outcome, above the fold.",
    },
    {
      id: "cta", weight: 18,
      label: th ? "ปุ่ม/ลิงก์เรียกให้ลงมือ (CTA)" : "Clear call-to-action",
      pass: ctaCount >= 1 && hasAnchorOrBtn,
      warn: ctaCount >= 1 && !hasAnchorOrBtn,
      detail: `CTA phrases: ${ctaCount}; clickable elements: ${hasAnchorOrBtn ? "yes" : "no"}.`,
      fix: th ? "เพิ่มปุ่มหลักเด่นๆ เช่น 'ขอใบเสนอราคา' หรือ 'แชทผ่าน LINE' ใกล้ส่วนบน" : "Add one prominent primary button, e.g. 'Get a quote' or 'Chat on LINE', near the top.",
    },
    {
      id: "contact_path", weight: 15,
      label: th ? "ช่องทางติดต่อ/ปิดการขาย" : "Contact / conversion path",
      pass: hasContactPath,
      detail: `tel:${hasTel} line:${hasLine} email:${hasMail} form:${hasForm}`,
      fix: th ? "ใส่ช่องทางปิดการขายอย่างน้อยหนึ่ง: โทร, LINE, หรือฟอร์มสั้นๆ" : "Add at least one closing path: phone, LINE, or a short form.",
    },
    {
      id: "line_path", weight: 10,
      label: th ? "ช่องทาง LINE (สำคัญในไทย)" : "LINE path (key in Thailand)",
      pass: hasLine,
      detail: hasLine ? "LINE link present." : "No LINE link found.",
      fix: th ? "คนไทยปิดการขายใน LINE — ใส่ปุ่ม 'เพิ่มเพื่อน LINE' (line.me/lin.ee)" : "Thai buyers close in LINE — add an 'Add LINE' button (line.me/lin.ee).",
    },
    {
      id: "trust", weight: 12,
      label: th ? "สัญญาณความน่าเชื่อถือ" : "Trust signals",
      pass: trustCount >= 2,
      warn: trustCount === 1,
      detail: `Trust cues found: ${trustCount}.`,
      fix: th ? "เพิ่มรีวิว/ผลงาน/มาตรฐาน/ปีประสบการณ์ ใกล้ปุ่มสั่งซื้อ" : "Add reviews, past work, certifications, or years of experience near the CTA.",
    },
    {
      id: "conversion_tracking", weight: 15,
      label: th ? "ติดตั้งโค้ดวัดผลโฆษณา" : "Conversion tracking installed",
      pass: tracking,
      detail: tracking ? "Analytics/pixel detected." : "No GA4/GTM/Meta/LINE/TikTok tracking detected.",
      fix: th ? "ติดตั้ง GA4/GTM + พิกเซลของช่องที่ยิงโฆษณา ไม่งั้นวัด ROI ไม่ได้ = เงินรั่ว" : "Install GA4/GTM + the pixel for the channels you advertise on; without it ad ROI is unmeasurable.",
    },
    {
      id: "form_friction", weight: 5,
      label: th ? "ฟอร์มไม่ยาวเกินไป" : "Low form friction",
      pass: !hasForm || fields <= 6,
      warn: hasForm && fields > 6 && fields <= 10,
      detail: hasForm ? `Form fields (visible): ${fields}.` : "No long form blocking conversion.",
      fix: th ? "ตัดช่องฟอร์มให้เหลือเท่าที่จำเป็น (ชื่อ + ช่องทางติดต่อ)" : "Cut the form to the essentials (name + one contact field).",
    },
    {
      id: "mobile_viewport", weight: 5,
      label: th ? "รองรับมือถือ (viewport)" : "Mobile viewport",
      pass: hasViewport,
      detail: hasViewport ? "viewport meta present." : "No viewport meta — mobile ad traffic will struggle.",
      fix: th ? "เพิ่ม <meta name=viewport content='width=device-width, initial-scale=1'>" : "Add a responsive viewport meta tag.",
    },
    {
      id: "ssr_content", weight: 5,
      label: th ? "เนื้อหาโหลดทันที (ไม่รอ JS)" : "Content loads without JS",
      pass: contentLen >= 300,
      detail: `Readable text length: ${contentLen} chars.`,
      fix: th ? "ให้เนื้อหาหลักแสดงได้โดยไม่รอ JavaScript เพื่อโหลดไว" : "Render core content server-side so it appears instantly.",
    },
  ];

  const checks = def.map((c) => {
    const status = c.pass ? "pass" : (c.warn ? "warn" : "fail");
    const earned = c.pass ? c.weight : (c.warn ? Math.round(c.weight / 2) : 0);
    return { id: c.id, label: c.label, status, weight: c.weight, earned, detail: c.detail, fix: c.fix };
  });

  const score = Math.max(0, Math.min(100, Math.round(checks.reduce((a, c) => a + c.earned, 0))));
  const leaks = checks
    .filter((c) => c.status !== "pass")
    .map((c) => ({ ...c, severity: c.status === "fail" ? (c.weight >= 12 ? "high" : "medium") : "low" }))
    .sort((a, b) => (b.weight - b.earned) - (a.weight - a.earned));

  return {
    url,
    conversion_score: score,
    grade: grade(score),
    tracking_detected: tracking,
    channels: { phone: hasTel, line: hasLine, email: hasMail, form: hasForm },
    form_fields: fields,
    content_chars: contentLen,
    checks,
    leaks,
  };
}

const HONEST_NOTE =
  "This audits the public landing page that receives your paid traffic. It cannot see your real ad spend or conversion numbers from the page alone — connect your ad account later for spend-level analysis. No guaranteed conversion lift is implied.";

export async function onRequestPost(context) {
  const { request, env } = context;

  // Rate limit — 5/min/IP, fail-CLOSED
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const rl = await checkRateLimit(env, ip, { max: 5, endpoint: "conversion-audit" });
  if (!rl.allowed) return rl429(rl.resetIn);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const url = normalizeUrl(payload.url || payload.scan?.url || payload.client_url || "");
  const providedHtml = typeof payload.html === "string" ? payload.html : "";
  if (!url && !providedHtml) return json({ error: "Provide a URL." }, 400);
  const lang = payload.lang === "th" ? "th" : "en";

  let html = providedHtml;
  if (!html) {
    const fetched = await rawFetchHtml(url);
    if (!fetched.html) return json({ error: "could_not_fetch_page", detail: fetched.error, url }, 502);
    html = fetched.html;
  }

  const analysis = analyzeConversion(html, url, lang);
  const cost = creditCost("conversion_audit");
  const status = await paidStatus(request, env);

  // Free deterministic preview — real value + honest upsell.
  if (!status.paid) {
    return json({
      status: "preview",
      paid: false,
      url: analysis.url,
      conversion_score: analysis.conversion_score,
      grade: analysis.grade,
      tracking_detected: analysis.tracking_detected,
      channels: analysis.channels,
      checks: analysis.checks,
      leaks: analysis.leaks.slice(0, 3),
      upgrade: {
        required: true,
        feature: "conversion_audit",
        credits_required: cost,
        message: {
          th: "ปลดล็อกแผนแก้ไขเฉพาะหน้าคุณ + ทุกจุดที่เงินค่าโฆษณารั่ว",
          en: "Unlock the full, site-specific fix plan and every leak.",
        },
      },
      honest_note: HONEST_NOTE,
    });
  }

  // Paid path — credit preflight (only when paid via credit balance).
  const creditDebit = status.reason === "credit_balance"
    ? { feature: "conversion_audit", amount: cost, idempotency_key: `conversion_audit:${url || "html"}`, metadata: { url } }
    : null;
  if (creditDebit) {
    const pre = await checkCreditBalance(request, env, creditDebit);
    if (!pre.ok) {
      return json({
        error: pre.error || "credit_debit_failed",
        upgrade_required: true,
        checkout_url: pre.checkout_url || "/?modal=credits",
        credits_required: pre.amount || cost,
        credits_balance: pre.balance ?? null,
        credits_needed: pre.needed ?? null,
      }, 402);
    }
  }

  // Site-specific fix plan, grounded ONLY on the failed deterministic checks.
  const failing = analysis.leaks.map((l) => ({ leak: l.id, label: l.label, status: l.status, detail: l.detail }));
  const system =
    `You are AI Mark's conversion-rate specialist for SMEs that buy ads. ` +
    `Given a landing page's deterministic conversion checks (some failing), write a prioritized, specific fix plan to stop ad spend leaking. ` +
    `Output STRICT JSON: {"summary": string, "fixes": [{"leak": string, "action": string, "why": string, "projected_impact": string}]}. ` +
    `Be concrete and honest. You only see the public page, not ad spend or conversions; never promise a guaranteed lift. ` +
    `Write all text in ${lang === "th" ? "Thai" : "English"}.`;
  const user =
    `URL: ${url || "(html provided)"}\n` +
    `Conversion score: ${analysis.conversion_score}/100 (${analysis.grade})\n` +
    `Tracking installed: ${analysis.tracking_detected}\n` +
    `Channels: ${JSON.stringify(analysis.channels)}\n` +
    `Failing/weak checks: ${JSON.stringify(failing)}\n` +
    `Page text excerpt: ${textOf(html).slice(0, 1200)}`;

  let fixPlan = null;
  let llmProvider = "";
  const llm = await callLLM(env, { system, messages: [{ role: "user", content: user }], maxTokens: 1400, temperature: 0 });
  if (llm.ok) { fixPlan = safeJson(llm.text); llmProvider = llm.provider; }

  // Only charge once we actually produced the paid value (the fix plan).
  let creditCharge = null;
  if (creditDebit && fixPlan) {
    creditCharge = await consumeCredits(request, env, creditDebit);
    if (!creditCharge.ok) {
      return json({
        error: creditCharge.error || "credit_debit_failed",
        upgrade_required: true,
        checkout_url: creditCharge.checkout_url || "/?modal=credits",
        credits_required: creditCharge.amount || cost,
        credits_balance: creditCharge.balance ?? null,
        credits_needed: creditCharge.needed ?? null,
      }, 402);
    }
  }

  return json({
    status: fixPlan ? "full" : "deterministic_only",
    paid: true,
    url: analysis.url,
    conversion_score: analysis.conversion_score,
    grade: analysis.grade,
    tracking_detected: analysis.tracking_detected,
    channels: analysis.channels,
    checks: analysis.checks,
    leaks: analysis.leaks,
    fix_plan: fixPlan,
    llm_provider: llmProvider || undefined,
    credit_charge: creditCharge,
    paid_reason: status.reason,
    llm_note: fixPlan ? undefined : "The fix plan could not be generated right now, so no credits were charged. The deterministic leaks above are still accurate.",
    honest_note: HONEST_NOTE,
  });
}
