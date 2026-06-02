/**
 * Cloudflare Pages Function — POST /api/lead-scout
 * ------------------------------------------------------------------
 * Finds outreach-ready SME prospects by combining public discovery signals
 * with a lightweight website visibility scan. It does NOT send spam. It builds
 * a prioritized queue with evidence and a personalized first message.
 *
 * Body: { query?, industry?, location?, lang?, max_results? }
 *
 * Env:
 *   SERPAPI_KEY   (best: Google organic/local/ads discovery)
 *   TAVILY_API_KEY (fallback: web discovery)
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AI-Mark-LeadScout/1.0";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }
function normText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function hasThai(s) { return /[\u0E00-\u0E7F]/.test(String(s || "")); }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } }
function originOf(u) { try { return new URL(u).origin; } catch { return ""; } }
function normalizeUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return ""; }
}
function brandFromHost(host) {
  return (host.split(".")[0] || "business").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function pathOf(u) { try { return new URL(u).pathname.toLowerCase(); } catch { return ""; } }
function originUrl(u) { const o = originOf(u); return o ? `${o}/` : ""; }

const BAD_HOST_RE =
  /(google|facebook|instagram|tiktok|youtube|linkedin|line|pantip|reddit|quora|medium|substack|wikipedia|stackoverflow|stackexchange|github|gitlab|npmjs|wordpress|shopee|lazada|thaiyellowpages|wongnai|agoda|booking|healthmap|openrice|tripadvisor|foursquare|yelp|directory|yellowpages|fact-link|maps)\./i;
const CONTENT_PATH_RE =
  /\/(blog|blogs|article|articles|news|knowledge|academy|docs|help|support|forum|forums|community|how-to|guide|guides|resources|tag|category|author)\b|\/20\d{2}\//i;

function isBadLeadUrl(url) {
  const h = hostOf(url);
  return !h ||
    /(\.go\.th|\.ac\.th|\.or\.th|\.edu|\.gov)$/i.test(h) ||
    BAD_HOST_RE.test(h) ||
    /\.(jpg|jpeg|png|webp|gif|pdf|zip)$/i.test(url);
}

function isLikelyContentPath(url) {
  return CONTENT_PATH_RE.test(pathOf(url));
}

function normalizeLeadUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized || isBadLeadUrl(normalized)) return null;
  if (isLikelyContentPath(normalized)) {
    const home = originUrl(normalized);
    if (!home || isBadLeadUrl(home)) return null;
    return { url: home, original_url: normalized, normalized_from_content: true };
  }
  return { url: normalized, original_url: normalized, normalized_from_content: false };
}

function commercialEvidence(facts, discovery = {}, host = "") {
  const blob = normText([
    facts.title,
    facts.description,
    facts.textSample,
    discovery.title,
    discovery.snippet,
    host,
  ].join(" "));
  const signals = [];
  if (facts.hasContact) signals.push("visible_contact_or_quote_path");
  if (/(บริการ|คลินิก|โรงงาน|ร้าน|บริษัท|จำกัด|ติดต่อ|ราคา|จอง|นัดหมาย|ใบเสนอราคา|service|services|clinic|factory|company|co\.|ltd|quote|booking|appointment|contact|pricing)/i.test(blob)) signals.push("commercial_service_language");
  if (/(กรุงเทพ|เชียงใหม่|ภูเก็ต|ชลบุรี|นนทบุรี|ปทุมธานี|thailand|bangkok|chiang mai|phuket|near me|local)/i.test(blob)) signals.push("local_market_signal");
  if (/(case study|portfolio|ผลงาน|รีวิว|ลูกค้า|testimonial|review|clients?)/i.test(blob)) signals.push("trust_or_work_signal");
  if (facts.wordCount >= 120) signals.push("substantive_business_page");
  const negative = /(reddit|forum|ชุมชน|บทความ|blog|how to|guide|tutorial|docs|documentation|sitemap คือ|คืออะไร|what is|news)/i.test(blob);
  return {
    score: Math.max(0, signals.length - (negative ? 1 : 0)),
    signals,
    negative_content_signal: negative,
  };
}

function queryIntent(query, lang = "en") {
  const q = normText(query).toLowerCase();
  const commercial = /(sme|lead|prospect|clinic|dental|factory|company|shop|store|restaurant|hotel|agency|service|services|contact|quote|pricing|price|booking|appointment|near me|local|ads|ad spend|facebook ads|google ads|ธุรกิจ|ลูกค้า|คลินิก|โรงงาน|ร้าน|บริษัท|บริการ|ติดต่อ|ราคา|ใบเสนอราคา|จอง|นัดหมาย|ยิงแอด|โฆษณา|ลดค่าแอด|เอสเอ็มอี)/i.test(q);
  const educational = /(sitemap|robots\.?txt|wordpress|seo|schema คือ|คืออะไร|what is|how to|tutorial|guide|docs|documentation|article|blog|บทความ|วิธี|สอน|คู่มือ|ความรู้|แผนผังเว็บ)/i.test(q);
  const adSpend = /(ads|ad spend|facebook ads|google ads|paid traffic|ยิงแอด|โฆษณา|ค่าแอด|ลดค่าแอด|ซื้อโฆษณา)/i.test(q);
  return {
    commercial,
    educational,
    ad_spend: adSpend,
    mode: commercial ? (adSpend ? "commercial_ad_spend" : "commercial") : educational ? "educational_or_content" : "unknown",
    hint: commercial
      ? ""
      : lang === "th"
        ? "คำค้นนี้ดูเหมือนหาข้อมูล/บทความ ไม่ใช่หา SME ที่ติดต่อได้ ให้เพิ่มอุตสาหกรรม + พื้นที่ + ติดต่อ/ราคา"
        : "This looks like an informational/content query, not an outreach-ready SME query. Add industry + location + contact/quote terms.",
  };
}

function qualificationDecision({ qualification, facts, discovery, intent, adHit }) {
  if (intent.educational && !intent.commercial && !adHit) {
    return {
      qualified: false,
      reason: "query_not_commercial_enough_for_outreach",
      min_score: 4,
      note: "Informational/content queries are not treated as SME prospect discovery.",
    };
  }
  if (qualification.negative_content_signal && !intent.commercial && !adHit) {
    return {
      qualified: false,
      reason: "content_result_not_outreach_lead",
      min_score: 4,
      note: "Result looks like an article/forum/docs page, not an outreach-ready business.",
    };
  }
  const minScore = discovery.normalized_from_content ? 3 : 2;
  if (qualification.score < minScore) {
    return {
      qualified: false,
      reason: "not_qualified_as_sme_business",
      min_score: minScore,
      note: "Not enough contact, local, service, or commercial evidence.",
    };
  }
  if (!facts.hasContact && !adHit && qualification.score < 3) {
    return {
      qualified: false,
      reason: "missing_contact_path",
      min_score: 3,
      note: "Organic prospects need a visible contact, quote, booking, phone, email, or LINE path.",
    };
  }
  return { qualified: true, reason: "qualified", min_score: minScore };
}

async function fetchText(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "th,en;q=0.9" },
      redirect: "follow",
      signal: ctrl.signal,
      cf: { cacheTtl: 0 },
    });
    return { ok: r.ok, status: r.status, finalUrl: r.url, body: await r.text(), headers: Object.fromEntries(r.headers) };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: url, body: "", error: String(e).slice(0, 120), headers: {} };
  } finally {
    clearTimeout(t);
  }
}

function pick(html, re) {
  const m = String(html || "").match(re);
  return m ? normText(m[1].replace(/<[^>]+>/g, " ")) : "";
}
function meta(html, attr, key) {
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    if (!new RegExp(`\\b${attr}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(tag)) continue;
    const m = tag.match(/\bcontent=["']([^"']*)["']/i);
    if (m) return normText(m[1]);
  }
  return "";
}
function pageFacts(html) {
  const text = normText(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "));
  const h1 = [...String(html || "").matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => normText(m[1].replace(/<[^>]+>/g, " "))).filter(Boolean);
  const imgCount = (html.match(/<img\b/gi) || []).length;
  const imgNoAlt = (html.match(/<img\b(?:(?!alt=)[^>])*>/gi) || []).length;
  return {
    title: pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description: meta(html, "name", "description"),
    canonical: pick(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i),
    viewport: meta(html, "name", "viewport"),
    ogTitle: meta(html, "property", "og:title"),
    ogDescription: meta(html, "property", "og:description"),
    ogImage: meta(html, "property", "og:image"),
    twitterCard: meta(html, "name", "twitter:card"),
    hasSchema: /application\/ld\+json|schema\.org/i.test(html),
    h1,
    wordCount: text ? text.split(/\s+/).length : 0,
    imgCount,
    imgMissingAlt: imgNoAlt,
    hasContact: /(โทร|ติดต่อ|line|ไลน์|email|อีเมล|phone|contact|quote|quotation|ใบเสนอราคา)/i.test(text),
    hasFaq: /(faq|frequently asked|คำถาม|ถามบ่อย|q&a|how to|what is|ทำไม|อย่างไร)/i.test(text),
    textSample: text.slice(0, 800),
  };
}

function scoreLead({ url, facts, fetchMs, resources, adHit, discovery }) {
  const failures = [];
  const add = (ok, label, weight) => { if (!ok) failures.push({ label, weight }); };
  add(/^https:/i.test(url), "Site is not HTTPS", 10);
  add(!!facts.title && facts.title.length >= 10, "Weak or missing title tag", 10);
  add(!!facts.description && facts.description.length >= 70, "Weak or missing meta description", 10);
  add(!!facts.viewport, "Missing mobile viewport", 6);
  add((facts.h1 || []).length > 0, "Missing clear H1", 6);
  add(!!facts.hasSchema, "No visible structured data/schema", 13);
  add(facts.wordCount >= 350, "Thin homepage content", 13);
  add(!!facts.hasFaq, "No buyer FAQ / answer-led content", 12);
  add(!!facts.ogTitle && !!facts.ogDescription && !!facts.ogImage, "Weak social preview / Open Graph", 10);
  add(!!resources.robots, "Missing robots.txt", 5);
  add(!!resources.sitemap, "Missing sitemap.xml", 5);
  add(!!resources.llms, "Missing llms.txt for AI crawlers", 6);
  add(fetchMs < 3500, "Slow or blocked homepage response", 6);
  add(!!facts.hasContact, "Weak visible contact/conversion path", 8);

  const max = 120;
  const lost = failures.reduce((a, x) => a + x.weight, 0);
  const weakScore = clamp(lost * 100 / max);
  const adBudgetSignal = clamp(
    (adHit ? 65 : 0) +
    (/ad|ads|ยิงแอด|facebook|lead|โฆษณา/i.test(discovery.snippet || "") ? 15 : 0) +
    ((facts.hasContact && facts.wordCount >= 120) ? 10 : 0)
  );
  const conversionLeak = clamp(
    (facts.hasContact ? 20 : 0) +
    (!facts.hasFaq ? 20 : 0) +
    (!facts.hasSchema ? 20 : 0) +
    ((!facts.ogTitle || !facts.ogImage) ? 15 : 0) +
    (facts.wordCount < 350 ? 15 : 0) +
    (!resources.llms ? 10 : 0)
  );
  const priority = clamp(weakScore * 0.55 + Math.max(adBudgetSignal, 35) * 0.25 + conversionLeak * 0.20);
  return { weakScore, adBudgetSignal, conversionLeak, priority, failures: failures.sort((a, b) => b.weight - a.weight) };
}

async function discoverSerp(env, query, lang, max) {
  if (!env.SERPAPI_KEY) return { provider: null, leads: [], adsHosts: new Set(), error: "SERPAPI_KEY not configured" };
  const hl = lang === "th" ? "th" : "en";
  const gl = lang === "th" ? "th" : "us";
  const url = "https://serpapi.com/search.json?engine=google&num=20&hl=" + hl + "&gl=" + gl +
    "&q=" + encodeURIComponent(query) + "&api_key=" + encodeURIComponent(env.SERPAPI_KEY);
  const r = await fetch(url);
  if (!r.ok) return { provider: "serpapi", leads: [], adsHosts: new Set(), error: `serpapi_${r.status}` };
  const d = await r.json();
  const ads = [...(d.ads || []), ...(d.inline_ads || []), ...(d.top_ads || []), ...(d.bottom_ads || [])];
  const adsHosts = new Set(ads.map((x) => hostOf(x.link || x.displayed_link || "")).filter(Boolean));
  const raw = [
    ...(d.local_results?.places || d.local_results || []),
    ...(d.organic_results || []),
    ...ads,
  ];
  const out = [];
  for (const item of raw) {
    const normalized = normalizeLeadUrl(item.website || item.link || item.url || "");
    if (!normalized) continue;
    out.push({
      url: normalized.url,
      original_url: normalized.original_url,
      normalized_from_content: normalized.normalized_from_content,
      title: item.title || item.name || brandFromHost(hostOf(normalized.url)),
      snippet: item.snippet || item.description || item.address || "",
      discovery_source: ads.includes(item) ? "google_ad" : item.website ? "google_local" : "google_organic",
    });
    if (out.length >= max * 2) break;
  }
  return { provider: "serpapi", leads: out, adsHosts, error: null };
}

async function discoverTavily(env, query, max) {
  if (!env.TAVILY_API_KEY) return { provider: null, leads: [], adsHosts: new Set(), error: "TAVILY_API_KEY not configured" };
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, search_depth: "basic", max_results: Math.min(20, max * 2) }),
  });
  if (!r.ok) return { provider: "tavily", leads: [], adsHosts: new Set(), error: `tavily_${r.status}` };
  const d = await r.json();
  const leads = (d.results || []).map((x) => {
    const normalized = normalizeLeadUrl(x.url);
    if (!normalized) return null;
    return {
      url: normalized.url,
      original_url: normalized.original_url,
      normalized_from_content: normalized.normalized_from_content,
      title: x.title || "",
      snippet: x.content || "",
      discovery_source: "tavily_search",
    };
  }).filter(Boolean);
  return { provider: "tavily", leads, adsHosts: new Set(), error: null };
}

function buildQuery(payload, lang) {
  const q = normText(payload.query);
  if (q) return q;
  const industry = normText(payload.industry) || (lang === "th" ? "คลินิก dental โรงงาน ร้านค้า SME" : "local SME services");
  const location = normText(payload.location) || (lang === "th" ? "ประเทศไทย" : "Thailand");
  return lang === "th"
    ? `${industry} ${location} ติดต่อ เว็บไซต์ ราคา`
    : `${industry} ${location} contact website quote`;
}

function outreachMessage({ lead, lang, query }) {
  const brand = lead.brand || brandFromHost(lead.host);
  const issues = lead.top_issues.slice(0, 3).join(", ");
  if (lang === "th") {
    return `สวัสดีครับ ทีม ${brand}\n\nผมทำ AI Mark เครื่องมือสแกนว่าเว็บ/เพจธุรกิจถูก Google และ AI อย่าง ChatGPT, Claude, Perplexity อ่านและแนะนำได้ดีแค่ไหนครับ\n\nผมลองเช็กจากข้อมูลสาธารณะแล้วเห็นจุดที่น่าจะทำให้เงินโฆษณารั่วได้: ${issues}\n\nถ้าคุณยิงแอดอยู่ การแก้ landing page + schema + AI crawler + social preview อาจช่วยให้ลูกค้าเข้าใจเร็วขึ้นและลดการพึ่งแอดระยะยาวได้ ผมส่งรูปสแกนฟรี 1 หน้าให้ดูก่อนได้ไหมครับ?`;
  }
  return `Hi ${brand} team,\n\nI run AI Mark, a scanner that checks whether a business website can be read and recommended by Google and AI engines like ChatGPT, Claude, and Perplexity.\n\nFrom public signals, I found a few issues that may be leaking ad spend: ${issues}.\n\nIf you are running ads, fixing the landing page, schema, AI-crawler access, and social preview can make the same traffic convert better and reduce long-term dependence on ads. Can I send you a free one-page scan screenshot?`;
}

function adSignalLabel(score, lang) {
  if (score >= 60) return lang === "th" ? "สูง: มีสัญญาณ paid-search/ad จากผลค้นหา" : "High: paid-search/ad signal found in discovery";
  if (score >= 35) return lang === "th" ? "กลาง: เป็นธุรกิจที่มี conversion path แต่ยังไม่ยืนยันงบแอด" : "Medium: business has a conversion path, but ad spend is not verified";
  return lang === "th" ? "ต่ำ/ยังไม่ยืนยัน: ต้องถามลูกค้าว่ายิงแอดอยู่หรือไม่" : "Low/provisional: ask whether the customer is running ads";
}

function buildOutreachPack({ lead, lang, query, rank }) {
  const brand = lead.brand || brandFromHost(lead.host);
  const topIssues = (lead.top_issues || []).slice(0, 5);
  const issueText = topIssues.slice(0, 3).join(", ");
  const confidence = lead.discovery_source === "google_ad_match" || lead.ad_budget_signal >= 60
    ? "high_public_evidence"
    : lead.priority_score >= 45
      ? "medium_public_evidence"
      : "provisional_public_evidence";
  const subject = lang === "th"
    ? `สแกนฟรี: ${brand} อาจเสียโอกาสจากเว็บ/AI search`
    : `Free scan: ${brand} may be missing web and AI-search visibility`;
  const message = outreachMessage({ lead, lang, query });
  const followUp = lang === "th"
    ? `ขออนุญาตตามอีกครั้งครับ ถ้าสะดวก ผมส่งภาพสแกนฟรี 1 หน้าให้ดูเฉพาะจุดที่แก้แล้วมีผลกับ lead/conversion ได้ ไม่ต้องให้รหัสผ่านหรือ token ใด ๆ กับ AI Mark ครับ`
    : `Quick follow-up. I can send a one-page free scan screenshot focused only on fixes that can affect leads and conversion. AI Mark does not need your password or tokens.`;
  const optOut = lang === "th"
    ? "ถ้าไม่สะดวกให้ผมติดต่อเรื่องนี้ แจ้งได้เลยครับ ผมจะไม่ทักซ้ำ"
    : "If this is not useful, reply no and I will not follow up again.";

  return {
    rank,
    evidence_scope: "public_scan_only",
    proof_snapshot: {
      brand,
      host: lead.host,
      url: lead.url,
      confidence,
      scores: {
        weak_score: lead.weak_score,
        ad_budget_signal: lead.ad_budget_signal,
        conversion_leak_score: lead.conversion_leak_score,
        priority_score: lead.priority_score,
      },
      ad_budget_signal_note: adSignalLabel(lead.ad_budget_signal, lang),
      top_issues: topIssues,
      public_evidence: lead.public_evidence || {},
      cannot_claim_without_access: [
        "actual_ad_spend",
        "CAC_or_CPA",
        "GA4_or_GSC_traffic_source",
        "conversion_rate",
      ],
      evidence_note: lang === "th"
        ? "หลักฐานนี้มาจาก public website/search signals เท่านั้น ยังไม่ใช่ข้อมูล GA4, GSC หรือบัญชีโฆษณาของลูกค้า"
        : "This evidence comes only from public website/search signals, not the customer's GA4, GSC, or ad account.",
    },
    free_scan_offer: {
      required: true,
      screenshot_title: lang === "th" ? `AI Mark Free Scan - ${brand}` : `AI Mark Free Scan - ${brand}`,
      what_to_capture: lang === "th"
        ? [
            "คะแนนรวมและหมวดที่ต่ำสุด",
            `ปัญหา 3 อันดับแรก: ${issueText || "public evidence issues"}`,
            "ข้อความว่า score ยังไม่รวมข้อมูล GA4/GSC/ad account ถ้าลูกค้ายังไม่เชื่อมต่อ",
          ]
        : [
            "Overall score and the weakest category",
            `Top 3 issues: ${issueText || "public evidence issues"}`,
            "A note that the score does not include GA4/GSC/ad-account data unless the customer connects them",
          ],
      proof_file_hint: `aimark-free-scan-${lead.host}.png`,
    },
    dm: {
      channel_hint: lang === "th"
        ? "ส่งผ่าน Facebook Page, LINE OA, contact form หรือ email ที่ลูกค้าเผยแพร่เองเท่านั้น"
        : "Use only the customer's public Facebook Page, LINE OA, contact form, or published email.",
      subject,
      message,
      follow_up: followUp,
      opt_out: optOut,
    },
    guardrails: lang === "th"
      ? [
          "ส่งแบบ one-to-one เท่านั้น ไม่ blast จำนวนมาก",
          "อย่าบอกว่าลูกค้าเสียเงินแอดจริง ถ้ายังไม่มีข้อมูลบัญชีโฆษณา",
          "แนบภาพสแกนฟรีก่อนขายงานแก้เว็บ",
          "ให้ทางปฏิเสธการติดต่อทุกครั้ง",
        ]
      : [
          "Send one-to-one only, not bulk spam.",
          "Do not claim actual wasted ad spend without ad-account evidence.",
          "Attach the free scan screenshot before pitching paid work.",
          "Always provide a clear opt-out.",
        ],
  };
}

function buildOutreachBatch({ ranked, lang, query, rejected }) {
  const sendOrder = ranked.slice(0, 20).map((lead, i) => ({
    rank: i + 1,
    brand: lead.brand,
    host: lead.host,
    url: lead.url,
    priority_score: lead.priority_score,
    confidence: lead.outreach_pack && lead.outreach_pack.proof_snapshot
      ? lead.outreach_pack.proof_snapshot.confidence
      : "provisional_public_evidence",
    first_action: lang === "th" ? "จับภาพสแกนฟรีก่อนส่ง DM" : "Capture the free scan screenshot before sending the DM",
  }));
  return {
    mode: "one_to_one_free_scan_outreach",
    query,
    daily_limit: 20,
    qualified_count: ranked.length,
    rejected_count: rejected.length,
    send_order: sendOrder,
    workflow: lang === "th"
      ? [
          { action: "capture_free_scan", detail: "สแกน lead อันดับต้น ๆ แล้วจับภาพ proof 1 หน้า" },
          { action: "personalize_dm", detail: "แก้ชื่อธุรกิจ ปัญหา 1-3 ข้อ และช่องทางติดต่อให้ตรงกับแต่ละราย" },
          { action: "send_one_by_one", detail: "ส่งไม่เกิน 20 ราย/วัน และพักจังหวะ ไม่ส่งข้อความซ้ำแบบสแปม" },
          { action: "log_response", detail: "บันทึกตอบกลับ/นัด demo/ไม่สนใจ เพื่อให้ agent ทำงานต่อ" },
        ]
      : [
          { action: "capture_free_scan", detail: "Scan each top lead and capture a one-page proof screenshot." },
          { action: "personalize_dm", detail: "Customize the business name, 1-3 issues, and channel per lead." },
          { action: "send_one_by_one", detail: "Send no more than 20 per day with human pacing, not repeated spam." },
          { action: "log_response", detail: "Record replies, demo bookings, and opt-outs for agent follow-up." },
        ],
    guardrail_summary: lang === "th"
      ? "ใช้เป็น outbound assistant สำหรับช่วยเตรียมหลักฐานและข้อความ ไม่ใช่ระบบยิงสแปมอัตโนมัติ"
      : "Use this as an outbound assistant for evidence and copy preparation, not as an automated spam sender.",
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const lang = payload.lang === "th" || hasThai(payload.query || payload.industry || payload.location) ? "th" : "en";
  const max = Math.max(3, Math.min(parseInt(payload.max_results, 10) || 10, 20));
  const query = buildQuery(payload, lang);
  const intent = queryIntent(query, lang);

  let discovery = await discoverSerp(env, query, lang, max);
  if (!discovery.leads.length) {
    const fallback = await discoverTavily(env, query, max);
    discovery = { ...fallback, adsHosts: discovery.adsHosts || fallback.adsHosts, previous_error: discovery.error };
  }
  if (!discovery.leads.length) {
    return json({
      error: "No discovery provider returned leads.",
      setup_required: "Set SERPAPI_KEY for Google/local/ad discovery or TAVILY_API_KEY for web discovery.",
      provider_error: discovery.error || discovery.previous_error || null,
    }, 200);
  }

  const seen = new Set();
  const candidates = discovery.leads.filter((x) => {
    const h = hostOf(x.url);
    if (!h || seen.has(h)) return false;
    seen.add(h);
    return true;
  }).slice(0, max);

  const scanned = await Promise.all(candidates.map(async (c) => {
    const started = Date.now();
    const home = await fetchText(c.url);
    const fetchMs = Date.now() - started;
    const finalUrl = home.finalUrl || c.url;
    const origin = originOf(finalUrl);
    const [robots, sitemap, llms] = await Promise.all([
      fetchText(origin + "/robots.txt", 4500),
      fetchText(origin + "/sitemap.xml", 4500),
      fetchText(origin + "/llms.txt", 4500),
    ]);
    const facts = home.ok ? pageFacts(home.body) : pageFacts("");
    const h = hostOf(finalUrl);
    const qualification = commercialEvidence(facts, c, h);
    const decision = qualificationDecision({ qualification, facts, discovery: c, intent, adHit: (discovery.adsHosts || new Set()).has(h) });
    if (!decision.qualified) {
      return {
        rejected: true,
        reason: decision.reason,
        url: finalUrl,
        host: h,
        discovery_title: c.title || "",
        discovery_snippet: c.snippet || "",
        decision,
        qualification,
      };
    }
    const adHit = (discovery.adsHosts || new Set()).has(h);
    const scored = scoreLead({
      url: finalUrl,
      facts,
      fetchMs,
      resources: {
        robots: robots.ok && /user-agent|allow|disallow/i.test(robots.body),
        sitemap: sitemap.ok && /<urlset|<sitemapindex|<url/i.test(sitemap.body),
        llms: llms.ok && llms.body.trim().length >= 30,
      },
      adHit,
      discovery: c,
    });
    const brand = facts.title ? facts.title.split(/\s+[|–—-]\s+/)[0].slice(0, 70) : (c.title || brandFromHost(h));
    const lead = {
      url: finalUrl,
      original_url: c.original_url || c.url,
      host: h,
      brand,
      discovery_source: adHit ? "google_ad_match" : c.discovery_source,
      normalized_from_content: !!c.normalized_from_content,
      discovery_title: c.title || "",
      discovery_snippet: c.snippet || "",
      fetch_status: home.status,
      weak_score: scored.weakScore,
      ad_budget_signal: scored.adBudgetSignal,
      conversion_leak_score: scored.conversionLeak,
      priority_score: scored.priority,
      top_issues: scored.failures.slice(0, 5).map((x) => x.label),
      public_evidence: {
        word_count: facts.wordCount,
        has_schema: facts.hasSchema,
        has_faq: facts.hasFaq,
        has_contact: facts.hasContact,
        has_og_image: !!facts.ogImage,
        has_llms_txt: llms.ok && llms.body.trim().length >= 30,
        homepage_response_ms: fetchMs,
      },
      qualification,
    };
    return lead;
  }));

  const rejected = scanned.filter((x) => x && x.rejected);
  const qualified = scanned.filter((x) => x && !x.rejected);
  if (!qualified.length) {
    return json({
      error: lang === "th" ? "ไม่พบ SME lead ที่ qualify จากผลค้นหาชุดนี้" : "No qualified SME leads found in this discovery set.",
      query,
      lang,
      provider: discovery.provider,
      search_intent: intent,
      rejected_count: rejected.length,
      rejected_examples: rejected.slice(0, 5).map((x) => ({ host: x.host, reason: x.reason, title: x.discovery_title, decision: x.decision, qualification: x.qualification })),
      next_query_hint: lang === "th"
        ? "ลองระบุอุตสาหกรรม + พื้นที่ + คำว่า ติดต่อ/ราคา เช่น 'คลินิก dental กรุงเทพ ติดต่อ ราคา'"
        : "Try industry + location + contact/quote terms, e.g. 'Bangkok dental clinic contact quote'.",
    }, 200);
  }

  const ranked = qualified.sort((a, b) => b.priority_score - a.priority_score);
  ranked.forEach((lead, i) => {
    lead.outreach_pack = buildOutreachPack({ lead, lang, query, rank: i + 1 });
    lead.outreach_message = lead.outreach_pack.dm.message;
  });
  const outreachBatch = buildOutreachBatch({ ranked, lang, query, rejected });
  return json({
    query,
    lang,
    provider: discovery.provider,
    search_intent: intent,
    generated_at: new Date().toISOString(),
    summary: lang === "th"
      ? `พบ ${ranked.length} ธุรกิจที่ควรติดต่อก่อน เรียงตามความอ่อนของเว็บ × สัญญาณงบโฆษณา × โอกาสลดเงินรั่ว`
      : `Found ${ranked.length} outreach candidates ranked by weak site signals × ad-budget signal × conversion leak.`,
    rejected_count: rejected.length,
    compliance_note: lang === "th"
      ? "ใช้ข้อความนี้แบบ personalized และส่งทีละราย อย่าส่งสแปมจำนวนมาก ควรแนบหลักฐานสแกนฟรีและให้ช่องทางปฏิเสธการติดต่อ"
      : "Use these as personalized one-to-one messages, not bulk spam. Attach the free scan evidence and provide a clear opt-out.",
    outreach_batch: outreachBatch,
    leads: ranked,
  });
}
