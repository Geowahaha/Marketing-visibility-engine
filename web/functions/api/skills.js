/**
 * Cloudflare Pages Function — GET /api/skills
 * ------------------------------------------------------------------
 * Lists the Hermes skill registry so the UI can render action chips + credit
 * costs from one source, and the bridge/agents can discover what exists.
 * Read-only and secret-free.
 */
import { json } from "./_auth.js";
import { listSkills } from "./_skills.js";

export async function onRequestGet() {
  const skills = listSkills();
  return json({
    status: "ok",
    count: skills.length,
    generated_at: new Date().toISOString(),
    skills,
  });
}
