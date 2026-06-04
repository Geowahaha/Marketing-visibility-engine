/**
 * POST /api/villages/found
 * Found the first village: register a curated guild of FOUNDER agents — a full
 * Thai-SME back-end-tech + growth team, each mapped to a real AI Mark capability
 * and the AI brain that fits it. They start at standing 0 (honest physics — even
 * founders earn their place by real work); over time they become the elders whose
 * weighted endorsements bootstrap newcomers, and the roots from which the family
 * tree grows. Idempotent.
 */
import { json, requireSession } from "../_auth.js";
import { agentKv } from "../_agent.js";
import { agentProfileKey, agentRepKey, addAgentToIndex, computeReputation, publicProfile } from "../_agents_registry.js";
import { ensureVillage } from "../_villages.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

const VILLAGE = "sme-growth-th";
const FOUNDERS = [
  { id: "visibility-scout", name: "Visibility Scout", provider: "claude", color: "#00a88f", bio: "ตรวจว่า AI และ Google เห็นธุรกิจคุณไหม — GEO/AEO/SEO", skills: ["scan", "ai_visibility", "answer_gap"] },
  { id: "tech-medic", name: "Tech Medic", provider: "codex", color: "#2e8fd7", bio: "หมอเทคนิคหลังบ้าน — security headers, ความเร็ว, โครงสร้างเว็บ", skills: ["tech_audit", "security", "performance"] },
  { id: "conversion-doctor", name: "Conversion Doctor", provider: "claude", color: "#e85d4f", bio: "เงินค่าโฆษณารั่วตรงไหน — landing, CTA, เส้นทางติดต่อ", skills: ["conversion_audit", "cta", "tracking"] },
  { id: "local-guide", name: "Local Guide", provider: "claude", color: "#f0aa2f", bio: "ลูกค้าในพื้นที่หาเจอไหม — Google Business / Local SEO", skills: ["local_seo_audit", "gbp", "maps"] },
  { id: "content-smith", name: "Content Smith", provider: "gemini", color: "#6f63d8", bio: "หน้าตอบคำถามลูกค้าที่ AI อยากอ้าง — answer-first + schema", skills: ["content", "faq_schema", "entity"] },
  { id: "deploy-hand", name: "Deploy Hand", provider: "codex", color: "#74b84f", bio: "ลงมือแก้จริง + deploy + พิสูจน์ before/after", skills: ["deploy", "github_pr", "proof"] },
];

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required" }, 401);
  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);

  await ensureVillage(kv, VILLAGE, { name: "SME Growth (Thailand)", purpose: "ทีมโตหลังบ้าน+การมองเห็นบน AI ของ SME ไทย", founder_sid: session.sid });
  const now = new Date().toISOString();
  const founded = [];
  let created = 0;
  for (const f of FOUNDERS) {
    const existing = await kv.get(agentProfileKey(f.id), "json");
    if (existing) { // idempotent — first founder owns them; don't clobber
      founded.push(publicProfile(existing, computeReputation((await kv.get(agentRepKey(f.id), "json")) || [])));
      continue;
    }
    const profile = {
      ...f, community: VILLAGE, founder: true, status: "founder", origin: "founder",
      owner_sid: session.sid, owner_email: session.email || "",
      generation: 0, parents: [], lineage: f.id, mutated_skills: [],
      joined_at: now, last_seen: now, created_at: now, updated_at: now,
    };
    await kv.put(agentProfileKey(f.id), JSON.stringify(profile));
    await addAgentToIndex(kv, f.id);
    created += 1;
    founded.push(publicProfile(profile, computeReputation([])));
  }
  return jc({ status: created ? "founded" : "already_founded", village: VILLAGE, created, founders: founded });
}
