/**
 * AIMarkBot — Bot Policy Helpers
 * robots.txt honoring (RFC 9309) + KV opt-out gate
 */

export function parseRobotsGroups(robotsTxt) {
  const lines = String(robotsTxt || "").split(/\r?\n/).map((l) => l.trim());
  const groups = [];
  let currentAgents = [];
  let currentRules = [];
  let inGroup = false;

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith("user-agent:")) {
      const agent = line.slice("user-agent:".length).trim().toLowerCase();
      if (inGroup && currentRules.length > 0) {
        // Rules already collected — new User-agent starts a new group
        groups.push({ agents: currentAgents, rules: currentRules });
        currentAgents = [];
        currentRules = [];
      }
      currentAgents.push(agent);
      inGroup = true;
    } else if (lower.startsWith("allow:") || lower.startsWith("disallow:")) {
      if (!inGroup) continue;
      const isAllow = lower.startsWith("allow:");
      const path = isAllow
        ? line.slice("allow:".length).trim()
        : line.slice("disallow:".length).trim();
      currentRules.push({ type: isAllow ? "allow" : "disallow", path });
    } else {
      // Non-rule directive (e.g. Sitemap:, Crawl-delay:) — just ignore for grouping
    }
  }
  if (currentAgents.length > 0) {
    groups.push({ agents: currentAgents, rules: currentRules });
  }
  return groups;
}

export function aimarkBotAccess(robotsTxt, path = "/") {
  if (path === "/robots.txt") {
    return { allowed: true, matchedGroup: "always", rule: "robots.txt always accessible" };
  }

  const groups = parseRobotsGroups(robotsTxt);

  let selectedGroup = null;
  let matchedGroupName = null;

  for (const g of groups) {
    if (g.agents.includes("aimarkbot")) {
      selectedGroup = g;
      matchedGroupName = "aimarkbot";
      break;
    }
  }
  if (!selectedGroup) {
    for (const g of groups) {
      if (g.agents.includes("*")) {
        selectedGroup = g;
        matchedGroupName = "*";
        break;
      }
    }
  }

  if (!selectedGroup) {
    return { allowed: true, matchedGroup: null, rule: null };
  }

  // Find the longest matching rule
  let bestRule = null;
  let bestLen = -1;
  let bestAllowed = true;

  for (const rule of selectedGroup.rules) {
    const rp = rule.path;
    // Empty Disallow means allow all — skip
    if (rule.type === "disallow" && rp === "") continue;

    let matches = false;
    let matchLen = 0;
    if (rp.endsWith("$")) {
      // Exact match
      const exact = rp.slice(0, -1);
      if (path === exact) { matches = true; matchLen = exact.length; }
    } else {
      if (path.startsWith(rp)) { matches = true; matchLen = rp.length; }
    }

    if (!matches) continue;

    if (matchLen > bestLen) {
      bestLen = matchLen;
      bestRule = rp;
      bestAllowed = rule.type === "allow";
    } else if (matchLen === bestLen && rule.type === "allow") {
      // Tie: allow wins
      bestAllowed = true;
      bestRule = rp;
    }
  }

  if (bestLen < 0) {
    return { allowed: true, matchedGroup: matchedGroupName, rule: null };
  }

  return { allowed: bestAllowed, matchedGroup: matchedGroupName, rule: bestRule };
}

export async function isOptedOut(env, host) {
  const kv = env && env.RATE_LIMIT_KV;
  if (!kv) return false;
  const normalized = host.toLowerCase().replace(/^www\./, "");
  try {
    const v = await kv.get("botoptout:" + normalized);
    return v !== null;
  } catch {
    return false;
  }
}
