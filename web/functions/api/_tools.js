/**
 * AI Mark — Agent Hub tool contract (single source of truth = _skills.js)
 * ------------------------------------------------------------------
 * One tool contract that every external model can call:
 *   - MCP server         POST /api/mcp        (Claude MCP connector, OpenAI Apps SDK)
 *   - REST adapter list  GET  /api/agent/tools
 *   - REST adapter exec  POST /api/agent/tools/:name
 *
 * Tools are DERIVED from the skill registry so adding a skill there adds a tool
 * here automatically. Execution dispatches to the existing skill endpoints, so
 * there is no second implementation to drift.
 *
 * Safety (approval-first, per improve connection.md guardrails):
 *   - Only read-only audit/analysis skills are auto-executable (AUTO_EXEC).
 *   - Credit-charged endpoints still enforce their own paywall (an unauthenticated
 *     tool call gets the free preview — it can never silently spend credits).
 *   - Deploy / write / send skills are DECLARED but gated: executeTool returns
 *     { error: "approval_required" } unless an approval token is supplied. They
 *     never run unattended from an external model.
 */

import { SKILLS, getSkill } from "./_skills.js";

/**
 * Read-only skills that are safe to run from an external model with no side
 * effects beyond a public fetch. Each maps a skill id to its real endpoint and
 * the arguments to forward.
 */
const AUTO_EXEC = {
  scan:                     { path: "/api/scan",             args: ["url"],   optional: ["lang"] },
  competitor:               { path: "/api/competitor",       args: ["url"],   optional: ["lang"] },
  citation_probe:           { path: "/api/citation-probe",   args: ["url"],   optional: ["lang"] },
  answer_gap:               { path: "/api/answer-gap",       args: ["url"],   optional: ["lang"] },
  social_visibility:        { path: "/api/social-visibility",args: ["url"],   optional: ["lang"] },
  conversion_audit:         { path: "/api/conversion-audit", args: ["url"],   optional: ["lang"] },
  local_seo_audit:          { path: "/api/local-seo-audit",  args: ["url"],   optional: ["lang"] },
  tech_audit:               { path: "/api/tech-audit",       args: ["url"],   optional: ["lang"] },
  ai_bot_intelligence_loop: { path: "/api/bot-intel",        args: ["url"],   optional: ["lang"] },
  lead_scout:               { path: "/api/lead-scout",       args: ["query"], optional: ["lang"] },
};

/** Friendly aliases so the contract matches common agent vocabulary. */
const ALIAS = {
  scan_site: "scan",
  browser_snapshot: "scan",
  competitor_gap: "competitor",
  ai_citations: "citation_probe",
  ad_audit: "conversion_audit",
  landing_audit: "conversion_audit",
  local_seo: "local_seo_audit",
  gbp_fixer: "local_seo_audit",
  security_audit: "tech_audit",
  bot_intel: "ai_bot_intelligence_loop",
  find_prospects: "lead_scout",
};

/** Resolve a tool name (alias or skill id) to a skill id. */
export function resolveToolId(name) {
  const key = String(name || "").trim().toLowerCase();
  if (ALIAS[key]) return ALIAS[key];
  const s = getSkill(key);
  return s ? s.id : "";
}

function argDescription(field, lang_default = "en") {
  switch (field) {
    case "url": return "Public website or social URL to analyze (https://…).";
    case "query": return "What prospects to find, e.g. 'accounting firms in Bangkok'.";
    case "scan": return "A prior scan result object (run the `scan` tool first).";
    case "lang": return "Response language: 'th' or 'en'.";
    case "account": return "Optional account/site key for proof history.";
    default: return field;
  }
}

/** Build a JSON Schema input for a skill from its declared input contract. */
function inputSchemaFor(skill) {
  const props = {};
  const required = [];
  const exec = AUTO_EXEC[skill.id];
  const fields = exec ? exec.args : (skill.input || []);
  const optional = exec ? (exec.optional || []) : ["lang"];
  for (const f of fields) {
    props[f] = { type: f === "scan" ? "object" : "string", description: argDescription(f) };
    required.push(f);
  }
  for (const f of optional) {
    if (props[f]) continue;
    props[f] = f === "lang"
      ? { type: "string", enum: ["th", "en"], description: argDescription(f) }
      : { type: "string", description: argDescription(f) };
  }
  return { type: "object", properties: props, required, additionalProperties: false };
}

/** Public tool definitions (MCP / OpenAI compatible). */
export function toolDefinitions() {
  return SKILLS.map((s) => {
    const executable = !!AUTO_EXEC[s.id];
    const gated = !executable;
    const credits = Math.max(0, Number(s.credit_cost) || 0);
    let description = `${s.label} — ${s.output || ""}`.trim();
    if (gated) description += " [requires owner approval]";
    else if (credits > 0) description += " [free preview without sign-in; full result costs " + credits + " credits when signed in]";
    return {
      name: s.id,
      title: s.label,
      title_th: s.label_th,
      description,
      inputSchema: inputSchemaFor(s),
      // Non-standard hints AI Mark consumers may read; MCP clients ignore unknown keys.
      _aimark: {
        executable,
        gated,
        credit_cost: credits,
        capabilities: [...s.capabilities],
        honesty: s.runner_hint || "",
      },
    };
  });
}

/**
 * Execute a tool by dispatching to its real endpoint.
 * @returns {Promise<{ok:boolean, status:number, result?:any, error?:string, detail?:any}>}
 */
export async function executeTool(name, args, context) {
  const id = resolveToolId(name);
  if (!id) return { ok: false, status: 404, error: "unknown_tool", detail: String(name || "") };
  const skill = getSkill(id);
  const exec = AUTO_EXEC[id];

  // Approval-first: declared-but-gated skills never auto-run from an external model.
  if (!exec) {
    const approved = String((args && args.approval_token) || "").trim();
    if (!approved) {
      return {
        ok: false,
        status: 403,
        error: "approval_required",
        detail: `${id} changes the site, sends messages, or spends credits — it must be approved by the owner in AI Mark, not auto-run. Use the AI Mark web app to approve and run it.`,
      };
    }
  }

  const a = args && typeof args === "object" ? args : {};
  const body = {};
  for (const f of (exec ? exec.args : skill.input || [])) {
    let v = a[f];
    if (f === "url") v = a.url || a.site || a.client_url || (a.scan && a.scan.url) || "";
    if (v == null || v === "") return { ok: false, status: 400, error: "missing_argument", detail: f };
    body[f] = v;
  }
  for (const f of (exec ? exec.optional || [] : ["lang"])) {
    if (a[f] != null && a[f] !== "") body[f] = a[f];
  }
  if (!body.lang) body.lang = a.lang === "th" ? "th" : "en";

  const path = exec ? exec.path : null;
  if (!path) return { ok: false, status: 501, error: "not_executable", detail: id };

  try {
    const origin = new URL(context.request.url).origin;
    const r = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
    return { ok: r.ok, status: r.status, result: data, tool: id };
  } catch (e) {
    return { ok: false, status: 502, error: "dispatch_failed", detail: String(e).slice(0, 300) };
  }
}
