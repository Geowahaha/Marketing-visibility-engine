/**
 * Agent-Readiness Fix Generator — the "we DO it for you" engine.
 * ------------------------------------------------------------------
 * Tools like isitagentready.com only emit a "Copy prompt" the human must paste
 * into their own coding agent. This breaks that wall: given a few facts about a
 * business, we GENERATE the actual deploy-ready files that make a site agent-ready
 * (the emerging standards: llms.txt, auth.md, robots Content-Signals, Agent Skills
 * index + SKILL.md, MCP server card). Deterministic + pure → testable, no LLM cost
 * at runtime. This is a sellable SME deliverable ("make your site agent-ready").
 */

export function bareHost(u) {
  return String(u || "").trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
}
const origin = (host) => `https://${host}`;
const esc = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();

export function generateLlmsTxt({ name, host, description, keyPages = [], contactEmail }) {
  const lines = [`# ${esc(name) || host}`, "", `> ${esc(description) || `${name} — official site.`}`, ""];
  lines.push(`${esc(name) || "This business"} publishes this llms.txt to help AI assistants understand and cite it accurately.`, "");
  if (keyPages.length) {
    lines.push("## Key pages");
    for (const p of keyPages.slice(0, 20)) lines.push(`- [${esc(p.title) || p.path}](${origin(host)}${p.path || "/"}): ${esc(p.desc) || ""}`.trimEnd());
    lines.push("");
  }
  lines.push("## Contact");
  if (contactEmail) lines.push(`- Email: ${esc(contactEmail)}`);
  lines.push(`- Website: ${origin(host)}`, "");
  return lines.join("\n");
}

export function generateAgentsTxt({ name, host, description }) {
  return [
    `# agents.txt — guidance for AI agents visiting ${host}`,
    "",
    `Site: ${origin(host)}`,
    `About: ${esc(description) || esc(name)}`,
    "",
    "Agents are welcome to read public content and cite this site.",
    `For a structured summary see ${origin(host)}/llms.txt`,
    `For authentication metadata see ${origin(host)}/auth.md`,
    "Please respect robots.txt and Content-Signal directives.",
    "",
  ].join("\n");
}

// H1 MUST contain "Auth.md" — that exact heading is what validators look for.
export function generateAuthMd({ name, host, hasOAuth = false, contactEmail }) {
  const head = [`# Auth.md`, "", `Canonical origin: ${origin(host)}`, "", `Agent authentication metadata for ${esc(name) || host}.`, "", "## Public agent access", `Agents may read public content per ${origin(host)}/robots.txt and ${origin(host)}/llms.txt.`, ""];
  if (hasOAuth) head.push("## Registration", `OAuth/OIDC discovery: ${origin(host)}/.well-known/oauth-authorization-server`, `Protected resource metadata: ${origin(host)}/.well-known/oauth-protected-resource`, "");
  else head.push("## Registration", `${esc(name) || "This site"} does not currently offer self-service OAuth or agent registration for API access.`, contactEmail ? `For programmatic access, contact ${esc(contactEmail)}.` : "", "");
  return head.filter((l) => l !== undefined).join("\n");
}

const AI_BOTS = ["GPTBot", "ChatGPT-User", "ClaudeBot", "Google-Extended", "PerplexityBot"];
export function generateRobotsTxt({ host, contentSignal = "ai-train=no, search=yes, ai-input=no", disallow = ["/api/"] }) {
  const block = (ua) => [`User-agent: ${ua}`, `Content-Signal: ${contentSignal}`, "Allow: /", ...disallow.map((d) => `Disallow: ${d}`)].join("\n");
  return [
    `Content-Signal: ${contentSignal}`,
    block("*"),
    ...AI_BOTS.map(block),
    "",
    `Sitemap: ${origin(host)}/sitemap.xml`,
    "",
  ].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

export function generateAgentSkillsIndex({ host }) {
  return JSON.stringify({
    $schema: "https://aimark.dev/schemas/agent-skills/v0.2.0.json",
    skills: [{
      name: "site-info",
      description: `Read structured business info and contact details for ${host}.`,
      version: "0.1.0",
      path: "/.well-known/agent-skills/site-info/SKILL.md",
    }],
  }, null, 2);
}

export function generateSiteInfoSkill({ name, host, description }) {
  return [
    "---", `name: site-info`, `description: Structured info about ${esc(name) || host} for AI agents.`, "version: 0.1.0", "---", "",
    `# Site info — ${esc(name) || host}`, "", esc(description) || "", "",
    "## How to use", `Fetch ${origin(host)}/llms.txt for a full machine-readable summary.`, "",
  ].join("\n");
}

export function generateMcpServerCard({ name, host }) {
  return JSON.stringify({
    schema_version: "2025-06-18",
    name: `${bareHost(host).split(".")[0]}-site`,
    description: `Public information server for ${esc(name) || host}.`,
    version: "0.1.0",
    metadata: { origin: origin(host), well_known: `${origin(host)}/.well-known/mcp/server-card.json` },
  }, null, 2);
}

/** Produce the full deploy-ready bundle. */
export function generateAgentReadinessBundle(info = {}) {
  const host = bareHost(info.url || info.host);
  if (!host) return { error: "url_required" };
  const ctx = { name: info.name || host, host, description: info.description || "", keyPages: Array.isArray(info.key_pages) ? info.key_pages : [], contactEmail: info.contact_email || "", hasOAuth: !!info.has_oauth };
  const files = [
    { path: "llms.txt", content_type: "text/markdown", content: generateLlmsTxt(ctx) },
    { path: "agents.txt", content_type: "text/plain", content: generateAgentsTxt(ctx) },
    { path: "auth.md", content_type: "text/markdown", content: generateAuthMd(ctx) },
    { path: "robots.txt", content_type: "text/plain", content: generateRobotsTxt(ctx) },
    { path: ".well-known/agent-skills/index.json", content_type: "application/json", content: generateAgentSkillsIndex(ctx) },
    { path: ".well-known/agent-skills/site-info/SKILL.md", content_type: "text/markdown", content: generateSiteInfoSkill(ctx) },
    { path: ".well-known/mcp/server-card.json", content_type: "application/json", content: generateMcpServerCard(ctx) },
  ];
  return { host, files, count: files.length, summary: files.map((f) => f.path) };
}
