/**
 * AI Mark — Hermes Skill Registry (single source of truth)
 * ------------------------------------------------------------------
 * One manifest per skill. Every other layer reads from here so that adding a
 * new skill is a one-place change instead of editing regexes in four files:
 *
 *   - Pricing   : _credits.js creditCost() reads `credit_cost` from here.
 *   - Bridge    : agent/jobs.js stamps `approved_actions` (least privilege) from
 *                 `capabilities` here; the local bridge already honors
 *                 payload.approved_actions.
 *   - UI/API    : GET /api/skills lists these manifests so action chips + credit
 *                 costs render from one source.
 *   - Validation: validateSkillInput() checks the declared input contract.
 *
 * To add a skill: append one entry below. Nothing else is required for it to be
 * priced, capability-gated, listed, and validatable.
 *
 * Capability glossary (least privilege — grant only what the skill needs):
 *   progress_report      report progress lines back to the owner
 *   public_http_fetch    fetch public URLs (SSRF-guarded in the bridge)
 *   browser_snapshot     headless read-only page snapshot
 *   browser_live_session interactive browser session (highest trust)
 *   file_write_workspace write generated files into the local workspace
 *   github_pr            open a pull request via the connected GitHub App/OAuth
 *   cloudflare_deploy    deploy via the Cloudflare injector
 *   line_draft           produce LINE OA drafts only (never sends; no tokens)
 */

const BASE_CAPABILITIES = ["progress_report"];

/** @type {Array<object>} */
export const SKILLS = [
  // ---- Free skills (cost 0) ---------------------------------------------
  {
    id: "scan",
    label: "Scan visibility",
    label_th: "สแกนการมองเห็น",
    kinds: ["scan", "site", "analytics"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch", "browser_snapshot"],
    input: ["url"],
    output: "Deterministic score + category findings + action plan.",
    proof: { baseline: true, recheck: true },
    runner_hint: "Fetch the site and report the deterministic visibility findings; do not invent metrics.",
  },
  {
    id: "improve",
    label: "Generate fixes",
    label_th: "สร้างชุดแก้ไข",
    kinds: ["improve"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["scan"],
    output: "head/OG, JSON-LD, robots, llms.txt, AEO FAQ, social calendar.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Generate paste-ready artifacts grounded in the scan facts.",
  },
  {
    id: "content_page",
    label: "Write content page",
    label_th: "เขียนหน้าเนื้อหา",
    kinds: ["content_page", "content", "write_page"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch", "file_write_workspace"],
    input: ["url"],
    output: "Publish-ready answer-first article(s) with FAQPage schema.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Answer real buyer questions, answer-first, with FAQ schema; never keyword-stuff.",
  },
  {
    id: "competitor",
    label: "Competitor gap",
    label_th: "ช่องว่างคู่แข่ง",
    kinds: ["competitor"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["url"],
    output: "Scored gap vs competitors + which fix closes each gap.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Compare on the same axes; show the concrete fix that closes each gap.",
  },
  {
    id: "citation_probe",
    label: "Test AI citations",
    label_th: "ทดสอบการอ้างอิงของ AI",
    kinds: ["citation_probe", "citation"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["url"],
    output: "Observed presence in AI answers at probe time (honest, not guaranteed).",
    proof: { baseline: false, recheck: false },
    runner_hint: "Report OBSERVED presence only; never promise a citation.",
  },
  {
    id: "answer_gap",
    label: "AI answer gap",
    label_th: "ช่องว่างคำตอบ AI",
    kinds: ["answer_gap"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["url"],
    output: "Which competitors AI names per buyer question + the page to win it.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Map each buyer question to the winning page to create.",
  },
  {
    id: "social_visibility",
    label: "Social visibility",
    label_th: "การมองเห็นโซเชียล",
    kinds: ["social_visibility", "social"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch", "browser_snapshot"],
    input: ["url"],
    output: "Per-channel deterministic score + account-specific fixes.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Score from real public signals; be honest about login-walled confidence.",
  },
  {
    id: "lead_scout",
    label: "Find prospects",
    label_th: "หาลูกค้าเป้าหมาย",
    kinds: ["lead_scout", "leads"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["query"],
    output: "Prioritized, evidence-backed prospect queue + a first message. Never spam.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Build evidence-backed leads only; do not send anything.",
  },
  {
    id: "site_improvement",
    label: "Improve my site",
    label_th: "ปรับปรุงเว็บให้ฉัน",
    kinds: ["site_improvement", "website_improvement", "aimark.website_improvement.request"],
    tier: "free",
    credit_cost: 0,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch", "browser_snapshot", "github_pr", "cloudflare_deploy"],
    input: ["scan"],
    output: "Applied fixes via PR/deploy (owner approves) + before/after.",
    proof: { baseline: true, recheck: true },
    runner_hint: "Propose changes as a PR/deploy for human approval; never ship silently.",
  },

  // ---- Credit-charged skills (costs MUST match _credits.js) --------------
  {
    id: "export_package",
    label: "Export full package",
    label_th: "ส่งออกแพ็กเกจเต็ม",
    kinds: ["export_package", "export"],
    tier: "credits",
    credit_cost: 100,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["scan"],
    output: "Complete downloadable fix bundle + paste/deploy guide.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Bundle every artifact with where-to-paste + how-to-verify notes.",
  },
  {
    id: "render_check",
    label: "Human vs AI render",
    label_th: "เทียบการเรนเดอร์คนกับ AI",
    kinds: ["render_check", "render"],
    tier: "credits",
    credit_cost: 75,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch", "browser_snapshot"],
    input: ["url"],
    output: "What a human sees vs what an AI bot sees (JS-render risk).",
    proof: { baseline: false, recheck: false },
    runner_hint: "Diff human vs bot render; flag content only visible after JS.",
  },
  {
    id: "proof_loop",
    label: "Prove before/after",
    label_th: "พิสูจน์ก่อน/หลัง",
    kinds: ["proof", "proof_loop"],
    tier: "credits",
    credit_cost: 50,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch", "browser_snapshot"],
    input: ["url"],
    output: "Re-scan + diff vs baseline + shareable proof link.",
    proof: { baseline: true, recheck: true },
    runner_hint: "Re-scan and diff against the stored baseline; show real deltas only.",
  },
  {
    id: "ai_bot_intelligence_loop",
    label: "AI bot intelligence",
    label_th: "วิเคราะห์บอท AI",
    kinds: ["ai_bot_intelligence_loop", "bot_intel", "bot_intelligence"],
    tier: "credits",
    credit_cost: 25,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["url"],
    output: "Per-bot access evidence + recommended agent actions.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Summarize per-bot served/blocked evidence and next actions.",
  },
  {
    id: "line_oa_growth_kit",
    label: "LINE OA growth kit",
    label_th: "ชุดโต LINE OA",
    kinds: ["line_oa_growth_kit", "line_oa", "line"],
    tier: "credits",
    credit_cost: 100,
    capabilities: [...BASE_CAPABILITIES, "line_draft"],
    input: ["url"],
    output: "Rich menu, welcome/quick replies, draft broadcasts, agent brief.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Produce LINE OA drafts only. Never request or store LINE tokens; never send.",
  },
  {
    id: "deploy_apply",
    label: "Apply to my site",
    label_th: "นำไปใช้กับเว็บฉัน",
    kinds: ["deploy_apply", "deploy", "apply"],
    tier: "credits",
    credit_cost: 150,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch", "github_pr", "cloudflare_deploy"],
    input: ["scan"],
    output: "Open a PR / deploy the fixes (owner approves) + capture baseline.",
    proof: { baseline: true, recheck: false },
    runner_hint: "Apply via PR/deploy for human approval; capture a baseline first.",
  },
  {
    id: "conversion_audit",
    label: "Ad / landing conversion audit",
    label_th: "ตรวจหน้าแลนดิ้ง — เงินค่าโฆษณารั่วตรงไหน",
    kinds: ["conversion_audit", "conversion", "ad_audit", "ads_audit", "landing_audit"],
    tier: "credits",
    credit_cost: 50,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["url"],
    output: "Conversion-readiness score + where ad spend leaks (offer, CTA, LINE/contact path, trust, tracking, form friction) + a site-specific fix plan.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Audit only the public landing page that receives paid traffic; report observable conversion leaks. Never claim to see ad spend or conversions without account access.",
  },
  {
    id: "local_seo_audit",
    label: "Google Business / Local SEO fixer",
    label_th: "ตัวช่วย Google Business / Local SEO",
    kinds: ["local_seo_audit", "local_seo", "gbp", "gbp_fixer", "google_business", "local_audit"],
    tier: "credits",
    credit_cost: 75,
    capabilities: [...BASE_CAPABILITIES, "public_http_fetch"],
    input: ["url"],
    output: "Local-readiness score (NAP, LocalBusiness schema, geo, hours, map, reviews, GBP link) + generated LocalBusiness JSON-LD + a Google Business Profile checklist.",
    proof: { baseline: false, recheck: false },
    runner_hint: "Audit on-site local signals from the public site only; generate LocalBusiness JSON-LD + a GBP action checklist. Never read or claim to read the live Google Business Profile; never invent an address or rating.",
  },
];

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));
const BY_KIND = new Map();
for (const s of SKILLS) {
  for (const k of [s.id, ...(s.kinds || [])]) BY_KIND.set(norm(k), s);
}

/** Look up a skill by its id or any registered kind/alias. */
export function getSkill(idOrKind) {
  const key = norm(idOrKind);
  return BY_ID.get(key) || BY_KIND.get(key) || null;
}

/** Resolve the skill for an enqueued job payload (skill_id > kind > type). */
export function skillForPayload(payload = {}) {
  return (
    getSkill(payload.skill_id) ||
    getSkill(payload.kind) ||
    getSkill(payload.type) ||
    null
  );
}

/** Credit cost for a skill id/kind. Unknown → 0 (never charge by accident). */
export function skillCreditCost(idOrKind) {
  const s = getSkill(idOrKind);
  return s ? Math.max(0, Number(s.credit_cost) || 0) : 0;
}

/** Least-privilege capabilities for a skill id/kind. Unknown → []. */
export function skillCapabilities(idOrKind) {
  const s = getSkill(idOrKind);
  return s ? [...s.capabilities] : [];
}

/** Public-safe manifest list for GET /api/skills and the UI. */
export function listSkills() {
  return SKILLS.map((s) => ({
    id: s.id,
    label: s.label,
    label_th: s.label_th,
    tier: s.tier,
    credit_cost: s.credit_cost,
    capabilities: [...s.capabilities],
    input: [...(s.input || [])],
    output: s.output || "",
    proof: { ...(s.proof || { baseline: false, recheck: false }) },
  }));
}

/** Loose input-contract check (not enforced in handlers yet). */
export function validateSkillInput(idOrKind, payload = {}) {
  const s = getSkill(idOrKind);
  if (!s) return { ok: false, error: "unknown_skill", missing: [] };
  const has = (field) =>
    payload[field] != null && payload[field] !== "" ||
    (field === "url" && (payload.client_url || payload.scan?.url));
  const missing = (s.input || []).filter((f) => !has(f));
  return { ok: missing.length === 0, missing, skill_id: s.id };
}
