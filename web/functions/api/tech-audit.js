/**
 * Cloudflare Pages Function — POST /api/tech-audit
 * ------------------------------------------------------------------
 * Technical & Security audit — closes the breadth gap vs agency scanners
 * (MetricSpot etc.): security headers, on-page structure, structured data,
 * trust/E-E-A-T, and tracking. Deterministic (same input → same score) so it is
 * trustworthy, then a paid LLM prioritized fix plan.
 *
 * Unlike report-only tools, this is one skill in AI Mark's loop: the gaps it
 * finds feed the Improve/Deploy lanes that actually fix them.
 *
 * Free  : deterministic score + every check (pass/fail) + top gaps.
 * Paid  : full gaps + LLM fix plan. Credits: "tech_audit" (skill registry).
 *
 * Body: { url | html?, headers?, lang? }
 */

import { paidStatus } from "./_auth.js";
import { checkCreditBalance, consumeCredits, creditCost } from "./_credits.js";
import { callLLM } from "./_llm.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AI-Mark-TechAudit/1.0";

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

function countMatches(s, re) { const m = String(s || "").match(re); return m ? m.length : 0; }

async function fetchWithHeaders(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", cf: { cacheTtl: 0 } });
    const headers = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const html = await r.text();
    return { ok: true, status: r.status, headers, html };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160), headers: {}, html: "" };
  }
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

function grade(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function sameHost(href, host) {
  try { return new URL(href, "https://" + host).hostname.replace(/^www\./, "") === host.replace(/^www\./, ""); } catch { return false; }
}

/**
 * Pure, deterministic technical & security analysis. Exported for tests so the
 * scoring needs no network, LLM, or credits.
 *   html    — page HTML
 *   headers — response headers as a lowercase-keyed object
 *   url     — final URL (used for HTTPS + internal-link host)
 */
export function analyzeTech(html, headers = {}, url = "", lang = "en") {
  const h = String(html || "");
  const th = lang === "th";
  const H = headers || {};
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const isHttps = /^https:/i.test(url);

  const hsts = !!H["strict-transport-security"];
  const clickjack = !!H["x-frame-options"] || /frame-ancestors/i.test(H["content-security-policy"] || "");
  const referrer = !!H["referrer-policy"];
  const noSniff = /nosniff/i.test(H["x-content-type-options"] || "");

  const canonical = /<link[^>]+rel=["']canonical["']/i.test(h);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(h);
  const h1count = countMatches(h, /<h1[\s>]/gi);
  const links = [...h.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const internalLinks = links.filter((href) => href && !/^(#|mailto:|tel:|javascript:)/i.test(href) && (host ? sameHost(href, host) : /^\//.test(href))).length;
  const imgs = countMatches(h, /<img\b/gi);
  const imgsWithAlt = countMatches(h, /<img\b[^>]*\balt=["'][^"']*["']/gi);
  const altCoverage = imgs === 0 ? 1 : imgsWithAlt / imgs;
  const titleMatch = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleLen = titleMatch ? textOf(titleMatch[1]).length : 0;
  const metaDesc = h.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
  const metaLen = metaDesc ? metaDesc[1].trim().length : 0;
  const hreflang = countMatches(h, /<link[^>]+hreflang=/gi);
  const langAttr = /<html[^>]+lang=/i.test(h);

  const jsonldCount = countMatches(h, /<script[^>]+type=["']application\/ld\+json["']/gi);
  const orgSchema = /"@type"\s*:\s*"(Organization|LocalBusiness|Corporation|[A-Za-z]*Business)"/i.test(h);
  const semanticTags = ["main", "article", "header", "nav", "footer", "section"].filter((t) => new RegExp("<" + t + "[\\s>]", "i").test(h)).length;
  const freshness = /"date(Published|Modified)"/i.test(h) || /datetime=["']/i.test(h) || /(อัปเดต|ปรับปรุงล่าสุด|updated|last updated)/i.test(textOf(h));

  const linkText = links.join(" ").toLowerCase() + " " + textOf(h).toLowerCase();
  const trustPages = ["about|เกี่ยวกับ", "contact|ติดต่อ", "privacy|ความเป็นส่วนตัว|นโยบาย", "terms|ข้อกำหนด|เงื่อนไข"]
    .filter((re) => new RegExp(re, "i").test(linkText)).length;
  const privacyLink = links.some((href) => /privacy|policy|ความเป็นส่วนตัว|นโยบาย/i.test(href));
  const analytics = /(googletagmanager\.com|gtag\(|google-analytics\.com|plausible\.io|fathom|matomo|umami|clarity\.ms|hotjar)/i.test(h);

  const def = [
    // Security headers
    { id: "https", w: 7, pass: isHttps, label: th ? "ใช้ HTTPS" : "HTTPS", detail: isHttps ? "Served over HTTPS." : "Not HTTPS.", fix: th ? "บังคับใช้ HTTPS ทั้งเว็บ" : "Serve the whole site over HTTPS." },
    { id: "hsts", w: 8, pass: hsts, label: th ? "HSTS header" : "HSTS header", detail: hsts ? "Strict-Transport-Security set." : "No Strict-Transport-Security header.", fix: th ? "เพิ่ม Strict-Transport-Security: max-age=63072000; includeSubDomains" : "Add Strict-Transport-Security: max-age=63072000; includeSubDomains." },
    { id: "clickjacking", w: 8, pass: clickjack, label: th ? "กัน clickjacking (X-Frame/CSP)" : "Clickjacking protection", detail: clickjack ? "X-Frame-Options or CSP frame-ancestors present." : "No X-Frame-Options / CSP frame-ancestors.", fix: th ? "เพิ่ม X-Frame-Options: SAMEORIGIN หรือ CSP frame-ancestors" : "Add X-Frame-Options: SAMEORIGIN or CSP frame-ancestors." },
    { id: "referrer_policy", w: 6, pass: referrer, label: "Referrer-Policy", detail: referrer ? "Referrer-Policy set." : "No Referrer-Policy header.", fix: th ? "เพิ่ม Referrer-Policy: strict-origin-when-cross-origin" : "Add Referrer-Policy: strict-origin-when-cross-origin." },
    { id: "x_content_type", w: 6, pass: noSniff, label: "X-Content-Type-Options", detail: noSniff ? "nosniff set." : "No X-Content-Type-Options: nosniff.", fix: th ? "เพิ่ม X-Content-Type-Options: nosniff" : "Add X-Content-Type-Options: nosniff." },
    // On-page structure
    { id: "canonical", w: 5, pass: canonical, label: th ? "Canonical link" : "Canonical link", detail: canonical ? "Canonical present." : "No rel=canonical.", fix: th ? "เพิ่ม <link rel=canonical>" : "Add <link rel=canonical>." },
    { id: "viewport", w: 4, pass: viewport, label: th ? "Viewport (มือถือ)" : "Viewport meta", detail: viewport ? "Viewport present." : "No viewport meta.", fix: th ? "เพิ่ม viewport meta" : "Add a responsive viewport meta." },
    { id: "single_h1", w: 5, pass: h1count === 1, warn: h1count > 1, label: th ? "H1 เดียว" : "Single H1", detail: `H1 count: ${h1count}.`, fix: th ? "ใช้ H1 เดียวต่อหน้า" : "Use exactly one H1 per page." },
    { id: "internal_links", w: 5, pass: internalLinks >= 3, warn: internalLinks >= 1, label: th ? "ลิงก์ภายใน" : "Internal links", detail: `Internal links: ${internalLinks}.`, fix: th ? "เพิ่มลิงก์ภายในอย่างน้อย 3-5 จุด" : "Add at least 3–5 internal links." },
    { id: "alt_coverage", w: 4, pass: altCoverage >= 0.8, warn: altCoverage >= 0.5, label: th ? "Alt text รูปภาพ" : "Image alt coverage", detail: `${imgsWithAlt}/${imgs} images have alt.`, fix: th ? "ใส่ alt ให้รูปทุกใบ" : "Add alt text to all meaningful images." },
    { id: "title_len", w: 3, pass: titleLen >= 30 && titleLen <= 60, warn: titleLen > 0, label: th ? "ความยาว title" : "Title length", detail: `Title: ${titleLen} chars.`, fix: th ? "ตั้ง title 30–60 ตัวอักษร" : "Keep the title 30–60 characters." },
    { id: "meta_desc", w: 4, pass: metaLen >= 110 && metaLen <= 165, warn: metaLen > 0, label: th ? "Meta description" : "Meta description", detail: metaLen ? `Meta description: ${metaLen} chars.` : "No meta description.", fix: th ? "เขียน meta description 120–155 ตัวอักษร" : "Write a 120–155 char meta description." },
    // Structured data / AI
    { id: "jsonld", w: 6, pass: jsonldCount >= 1, label: "JSON-LD schema", detail: `${jsonldCount} JSON-LD block(s).`, fix: th ? "เพิ่ม JSON-LD structured data" : "Add JSON-LD structured data." },
    { id: "org_schema", w: 5, pass: orgSchema, label: th ? "Organization schema" : "Organization schema", detail: orgSchema ? "Organization/Business schema present." : "No Organization schema.", fix: th ? "เพิ่ม Organization JSON-LD (name, logo, sameAs)" : "Add Organization JSON-LD (name, logo, sameAs)." },
    { id: "semantic", w: 5, pass: semanticTags >= 4, warn: semanticTags >= 2, label: th ? "HTML5 semantic tags" : "Semantic HTML5 tags", detail: `${semanticTags}/6 semantic tags.`, fix: th ? "ใช้ main/article/header/nav/footer/section" : "Use main/article/header/nav/footer/section." },
    { id: "freshness", w: 4, pass: freshness, label: th ? "สัญญาณความสดใหม่" : "Freshness signal", detail: freshness ? "Date/updated signal present." : "No publish/update date.", fix: th ? "แสดงวันที่อัปเดต + datePublished/dateModified" : "Show an updated date + datePublished/dateModified." },
    // Trust / privacy / stack
    { id: "trust_pages", w: 6, pass: trustPages >= 3, warn: trustPages >= 1, label: th ? "หน้า Trust (about/contact/privacy/terms)" : "Trust pages linked", detail: `${trustPages}/4 trust pages linked.`, fix: th ? "ลิงก์ about/contact/privacy/terms จาก footer" : "Link about/contact/privacy/terms from the footer." },
    { id: "privacy_link", w: 4, pass: privacyLink, label: th ? "ลิงก์นโยบายความเป็นส่วนตัว" : "Privacy policy link", detail: privacyLink ? "Privacy link present." : "No privacy policy link.", fix: th ? "เพิ่มลิงก์หน้านโยบายความเป็นส่วนตัว (PDPA/GDPR)" : "Add a privacy policy link (PDPA/GDPR)." },
    { id: "analytics", w: 5, pass: analytics, label: th ? "ติดตั้ง analytics" : "Web analytics installed", detail: analytics ? "Analytics detected." : "No web analytics detected.", fix: th ? "ติดตั้ง GA4/GTM หรือ analytics ที่เคารพความเป็นส่วนตัว" : "Install GA4/GTM or a privacy-friendly analytics tool." },
  ];

  const checks = def.map((c) => {
    const status = c.pass ? "pass" : (c.warn ? "warn" : "fail");
    const earned = c.pass ? c.w : (c.warn ? Math.round(c.w / 2) : 0);
    return { id: c.id, label: c.label, status, weight: c.w, earned, detail: c.detail, fix: c.fix };
  });
  const score = Math.max(0, Math.min(100, Math.round(checks.reduce((a, c) => a + c.earned, 0))));
  const leaks = checks
    .filter((c) => c.status !== "pass")
    .map((c) => ({ ...c, severity: c.status === "fail" ? (c.weight >= 6 ? "high" : "medium") : "low" }))
    .sort((a, b) => (b.weight - b.earned) - (a.weight - a.earned));

  return {
    url,
    tech_score: score,
    grade: grade(score),
    security: { https: isHttps, hsts, clickjacking: clickjack, referrer_policy: referrer, x_content_type_options: noSniff },
    checks,
    leaks,
  };
}

const HONEST_NOTE =
  "Deterministic technical & security audit from the page HTML and response headers. Unlike report-only scanners, the gaps here feed AI Mark's Improve/Deploy lanes that actually fix them.";

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const url = normalizeUrl(payload.url || payload.scan?.url || payload.client_url || "");
  const providedHtml = typeof payload.html === "string" ? payload.html : "";
  if (!url && !providedHtml) return json({ error: "Provide a URL." }, 400);
  const lang = payload.lang === "th" ? "th" : "en";

  let html = providedHtml;
  let headers = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
  if (!providedHtml) {
    const fetched = await fetchWithHeaders(url);
    if (!fetched.ok || !fetched.html) return json({ error: "could_not_fetch_page", detail: fetched.error || "empty", url }, 502);
    html = fetched.html; headers = fetched.headers;
  }

  const analysis = analyzeTech(html, headers, url || "https://example.com", lang);
  const cost = creditCost("tech_audit");
  const status = await paidStatus(request, env);

  if (!status.paid) {
    return json({
      status: "preview",
      paid: false,
      url: analysis.url,
      tech_score: analysis.tech_score,
      grade: analysis.grade,
      security: analysis.security,
      checks: analysis.checks, // full check list free — so we visibly match agency scanners
      leaks: analysis.leaks.slice(0, 3),
      upgrade: {
        required: true,
        feature: "tech_audit",
        credits_required: cost,
        message: {
          th: "ปลดล็อกแผนแก้ไขทางเทคนิค/ความปลอดภัยแบบจัดลำดับความสำคัญ",
          en: "Unlock the prioritized technical & security fix plan.",
        },
      },
      honest_note: HONEST_NOTE,
    });
  }

  const creditDebit = status.reason === "credit_balance"
    ? { feature: "tech_audit", amount: cost, idempotency_key: `tech_audit:${url || "html"}`, metadata: { url } }
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

  const failing = analysis.leaks.map((l) => ({ gap: l.id, label: l.label, severity: l.severity, detail: l.detail }));
  const system =
    `You are AI Mark's technical SEO & web-security specialist. ` +
    `Given a page's failing deterministic technical/security checks, produce a prioritized fix plan an owner or developer can apply. ` +
    `Output STRICT JSON: {"summary": string, "fixes": [{"gap": string, "action": string, "where": string, "why": string}]}. ` +
    `For security headers, give the exact header line. Be concrete and honest; never claim a ranking guarantee. ` +
    `Write all human-readable text in ${lang === "th" ? "Thai" : "English"}.`;
  const user =
    `URL: ${url || "(html provided)"}\n` +
    `Technical score: ${analysis.tech_score}/100 (${analysis.grade})\n` +
    `Security headers: ${JSON.stringify(analysis.security)}\n` +
    `Failing/weak checks: ${JSON.stringify(failing)}`;

  let fixPlan = null, llmProvider = "";
  const llm = await callLLM(env, { system, messages: [{ role: "user", content: user }], maxTokens: 1600, temperature: 0 });
  if (llm.ok) { fixPlan = safeJson(llm.text); llmProvider = llm.provider; }

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
    tech_score: analysis.tech_score,
    grade: analysis.grade,
    security: analysis.security,
    checks: analysis.checks,
    leaks: analysis.leaks,
    fix_plan: fixPlan,
    llm_provider: llmProvider || undefined,
    credit_charge: creditCharge,
    paid_reason: status.reason,
    llm_note: fixPlan ? undefined : "The fix plan could not be generated right now, so no credits were charged. The deterministic gaps above are still accurate.",
    honest_note: HONEST_NOTE,
  });
}
