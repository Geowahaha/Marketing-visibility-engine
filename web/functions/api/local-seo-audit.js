/**
 * Cloudflare Pages Function — POST /api/local-seo-audit
 * ------------------------------------------------------------------
 * Google Business / Local SEO "fixer". For local & service SMEs, most buyers
 * arrive through Google Maps / the local pack / "near me" AI answers. This
 * audits the on-site local-search signals deterministically (NAP, LocalBusiness
 * schema, geo, hours, map, area served, reviews, a Google Business link), then —
 * for paid users — GENERATES the actual fix: ready-to-paste LocalBusiness
 * JSON-LD + a prioritized Google Business Profile checklist + sample replies.
 *
 * Honest: it can only read the public website, not the live Google Business
 * Profile (that needs the owner's Google account). It audits the on-site
 * signals that feed local search and hands back a GBP action plan.
 *
 * Free  : deterministic local-readiness score + checks + top gaps.
 * Paid  : full gaps + generated LocalBusiness JSON-LD + GBP checklist.
 *         Credits: "local_seo_audit" (priced in the skill registry, _skills.js).
 *
 * Body: { url | html?, business?, lang? }
 */

import { paidStatus } from "./_auth.js";
import { checkCreditBalance, consumeCredits, creditCost } from "./_credits.js";
import { callLLM } from "./_llm.js";
import { checkRateLimit, rl429 } from "./_ratelimit.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AI-Mark-LocalSEO/1.0";

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

/**
 * Pure, deterministic local-SEO readiness analysis. Exported for tests so the
 * scoring needs no network, LLM, or credits. Same input → same score.
 */
export function analyzeLocalSeo(html, url = "", lang = "en") {
  const h = String(html || "");
  const th = lang === "th";

  const hasTelLink = /href=["']tel:/i.test(h);
  const hasSchemaPhone = /"telephone"\s*:/i.test(h);
  const hasThaiPhone = /\b0\d{1,2}[-\s]?\d{3}[-\s]?\d{3,4}\b/.test(h);
  const phone = hasTelLink || hasSchemaPhone || hasThaiPhone;

  const hasAddrTag = /<address[\s>]/i.test(h);
  const hasSchemaAddr = /"(streetAddress|postalCode|addressLocality|PostalAddress)"/i.test(h);
  const hasThaiAddr = /(ถนน|ตำบล|ต\.|อำเภอ|อ\.|จังหวัด|จ\.|แขวง|เขต|รหัสไปรษณีย์)\s*/.test(h) && /\b\d{5}\b/.test(h);
  const address = hasAddrTag || hasSchemaAddr || hasThaiAddr;

  const localBusinessSchema = /"@type"\s*:\s*"(LocalBusiness|Store|Restaurant|Cafe|Bakery|Hotel|Dentist|Physician|Attorney|LegalService|Plumber|Electrician|HomeAndConstructionBusiness|GeneralContractor|ProfessionalService|AutoRepair|HealthAndBeautyBusiness|FoodEstablishment|MedicalBusiness|Organization)"/i.test(h);
  const geo = /(GeoCoordinates|"latitude"\s*:|maps\.google|google\.[a-z.]+\/maps|goo\.gl\/maps|g\.page)/i.test(h);
  const hours = /(openingHours|openingHoursSpecification|เวลาทำการ|เวลาเปิด|เปิดทำการ|เปิด-ปิด|business\s*hours|mon[-–\s]|จันทร์[-–\s])/i.test(h);
  const mapEmbed = /<iframe[^>]+(google\.[a-z.]+\/maps|maps\.google|maps\.app)/i.test(h) || /(google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)/i.test(h);
  const areaServed = /(areaServed|พื้นที่ให้บริการ|ให้บริการพื้นที่|service\s*area|ทั่วประเทศ|ทั่วกรุงเทพ|จัดส่งทั่ว)/i.test(h);
  const reviews = /(aggregateRating|"reviewRating"|"@type"\s*:\s*"Review"|รีวิว|ความคิดเห็นลูกค้า|\bratings?\b|\bstars?\b)/i.test(h);
  const gbpLink = /(g\.page|business\.google|maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps\/place|"sameAs")/i.test(h);

  const def = [
    {
      id: "nap_phone", weight: 14, pass: phone,
      label: th ? "เบอร์โทรติดต่อ (NAP)" : "Contact phone (NAP)",
      detail: phone ? "Phone present (tel/schema/visible)." : "No phone number detected.",
      fix: th ? "ใส่เบอร์โทรเป็นลิงก์ <a href='tel:...'> และใน schema telephone" : "Add a tappable tel: phone link and a schema telephone.",
    },
    {
      id: "nap_address", weight: 14, pass: address,
      label: th ? "ที่อยู่ร้าน/บริษัท (NAP)" : "Business address (NAP)",
      detail: address ? "Address present." : "No clear postal address detected.",
      fix: th ? "ใส่ที่อยู่เต็มให้ตรงกับ Google Business (ถนน/ตำบล/อำเภอ/จังหวัด/รหัสไปรษณีย์)" : "Add the full postal address matching your Google Business Profile.",
    },
    {
      id: "localbusiness_schema", weight: 18, pass: localBusinessSchema,
      label: th ? "LocalBusiness JSON-LD schema" : "LocalBusiness JSON-LD schema",
      detail: localBusinessSchema ? "LocalBusiness/Organization schema found." : "No LocalBusiness schema — Google/AI can't read your business entity.",
      fix: th ? "เพิ่ม LocalBusiness JSON-LD (name, address, geo, telephone, openingHours, sameAs)" : "Add LocalBusiness JSON-LD (name, address, geo, telephone, openingHours, sameAs).",
    },
    {
      id: "geo_coordinates", weight: 10, pass: geo,
      label: th ? "พิกัด/แผนที่ (geo)" : "Geo coordinates / map",
      detail: geo ? "Geo/maps signal present." : "No geo coordinates or map signal.",
      fix: th ? "เพิ่ม geo (lat/lng) ใน schema และฝังแผนที่ Google" : "Add geo (lat/lng) to schema and embed a Google map.",
    },
    {
      id: "opening_hours", weight: 10, pass: hours,
      label: th ? "เวลาทำการ" : "Opening hours",
      detail: hours ? "Opening hours present." : "No opening hours on the page.",
      fix: th ? "แสดงเวลาทำการบนหน้า และใส่ openingHoursSpecification ใน schema" : "Show opening hours and add openingHoursSpecification to schema.",
    },
    {
      id: "map_embed", weight: 8, pass: mapEmbed,
      label: th ? "ฝัง/ลิงก์ Google Maps" : "Google Maps embed/link",
      detail: mapEmbed ? "Maps embed/link present." : "No Google Maps embed or link.",
      fix: th ? "ฝังแผนที่ Google หรือใส่ลิงก์ไปยังหมุดร้านบน Maps" : "Embed a Google map or link to your Maps place pin.",
    },
    {
      id: "area_served", weight: 6, pass: areaServed,
      label: th ? "พื้นที่ให้บริการ" : "Area served",
      detail: areaServed ? "Service area stated." : "No service area stated.",
      fix: th ? "ระบุพื้นที่ให้บริการ (อำเภอ/จังหวัด/ทั่วประเทศ)" : "State the area you serve (district/province/nationwide).",
    },
    {
      id: "reviews", weight: 12, pass: reviews,
      label: th ? "รีวิว/เรตติ้ง" : "Reviews / ratings",
      detail: reviews ? "Review/rating signal present." : "No reviews or ratings shown.",
      fix: th ? "แสดงรีวิวลูกค้าจริง + aggregateRating schema (ห้ามปลอม)" : "Show real customer reviews + aggregateRating schema (never fake).",
    },
    {
      id: "gbp_link", weight: 8, pass: gbpLink,
      label: th ? "เชื่อมโยง Google Business (sameAs)" : "Google Business link (sameAs)",
      detail: gbpLink ? "Google Business/Maps link or sameAs present." : "No link to your Google Business / Maps profile.",
      fix: th ? "ลิงก์ไปยัง Google Business Profile และใส่ใน sameAs ของ schema" : "Link to your Google Business Profile and add it to schema sameAs.",
    },
  ];

  const checks = def.map((c) => ({
    id: c.id, label: c.label,
    status: c.pass ? "pass" : "fail",
    weight: c.weight, earned: c.pass ? c.weight : 0,
    detail: c.detail, fix: c.fix,
  }));

  const score = Math.max(0, Math.min(100, Math.round(checks.reduce((a, c) => a + c.earned, 0))));
  const leaks = checks
    .filter((c) => c.status !== "pass")
    .map((c) => ({ ...c, severity: c.weight >= 12 ? "high" : (c.weight >= 8 ? "medium" : "low") }))
    .sort((a, b) => b.weight - a.weight);

  return {
    url,
    local_score: score,
    grade: grade(score),
    signals: {
      phone, address, localbusiness_schema: localBusinessSchema, geo,
      opening_hours: hours, map: mapEmbed, area_served: areaServed, reviews, gbp_link: gbpLink,
    },
    checks,
    leaks,
  };
}

const HONEST_NOTE =
  "This audits the on-site local-search signals on your public website. It cannot read your live Google Business Profile (that needs your Google account) — it gives you the on-site fixes plus a GBP action checklist. No guaranteed local ranking is implied.";

export async function onRequestPost(context) {
  const { request, env } = context;

  // Rate limit — 5/min/IP, fail-CLOSED (LLM is behind paid gate but paid users can still spam)
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const rl = await checkRateLimit(env, ip, { max: 5, endpoint: "local-seo-audit" });
  if (!rl.allowed) return rl429(rl.resetIn);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const url = normalizeUrl(payload.url || payload.scan?.url || payload.client_url || "");
  const providedHtml = typeof payload.html === "string" ? payload.html : "";
  if (!url && !providedHtml) return json({ error: "Provide a URL." }, 400);
  const lang = payload.lang === "th" ? "th" : "en";
  const business = String(payload.business || payload.brand || "").slice(0, 120);

  let html = providedHtml;
  if (!html) {
    const fetched = await rawFetchHtml(url);
    if (!fetched.html) return json({ error: "could_not_fetch_page", detail: fetched.error, url }, 502);
    html = fetched.html;
  }

  const analysis = analyzeLocalSeo(html, url, lang);
  const cost = creditCost("local_seo_audit");
  const status = await paidStatus(request, env);

  if (!status.paid) {
    return json({
      status: "preview",
      paid: false,
      url: analysis.url,
      local_score: analysis.local_score,
      grade: analysis.grade,
      signals: analysis.signals,
      checks: analysis.checks,
      leaks: analysis.leaks.slice(0, 3),
      upgrade: {
        required: true,
        feature: "local_seo_audit",
        credits_required: cost,
        message: {
          th: "ปลดล็อก LocalBusiness schema พร้อมวาง + เช็กลิสต์ Google Business เต็ม",
          en: "Unlock ready-to-paste LocalBusiness schema + the full Google Business checklist.",
        },
      },
      honest_note: HONEST_NOTE,
    });
  }

  const creditDebit = status.reason === "credit_balance"
    ? { feature: "local_seo_audit", amount: cost, idempotency_key: `local_seo_audit:${url || "html"}`, metadata: { url } }
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

  const failing = analysis.leaks.map((l) => ({ gap: l.id, label: l.label, detail: l.detail }));
  const system =
    `You are AI Mark's local-SEO / Google Business specialist for SMEs. ` +
    `Given a website's deterministic local-signal checks (some failing), produce the on-site fix and a Google Business Profile action plan. ` +
    `Output STRICT JSON: {"summary": string, "localbusiness_jsonld": string, "gbp_checklist": [{"task": string, "why": string}], "review_reply_samples": [{"scenario": string, "reply": string}]}. ` +
    `"localbusiness_jsonld" must be a single valid JSON-LD <script> body for this business (use placeholders the owner can fill, never invent an address or rating). ` +
    `Be honest: you only see the public website, not the live Google Business Profile; never promise guaranteed ranking. ` +
    `Write all human-readable text in ${lang === "th" ? "Thai" : "English"}.`;
  const user =
    `Business: ${business || "(infer from page)"}\n` +
    `URL: ${url || "(html provided)"}\n` +
    `Local readiness score: ${analysis.local_score}/100 (${analysis.grade})\n` +
    `Signals: ${JSON.stringify(analysis.signals)}\n` +
    `Failing checks: ${JSON.stringify(failing)}\n` +
    `Page text excerpt: ${textOf(html).slice(0, 1200)}`;

  let fixPlan = null;
  let llmProvider = "";
  const llm = await callLLM(env, { system, messages: [{ role: "user", content: user }], maxTokens: 1800, temperature: 0 });
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
    local_score: analysis.local_score,
    grade: analysis.grade,
    signals: analysis.signals,
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
