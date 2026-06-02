import { json } from "./_auth.js";

function present(value) {
  return !!value;
}

function firstPresent(env, keys) {
  return keys.find((key) => present(env[key])) || "";
}

function item(id, label, ready, detail, setup = "", meta = {}) {
  return {
    id,
    label,
    status: ready ? "ready" : "missing",
    ready: !!ready,
    detail,
    setup,
    ...meta,
  };
}

function groupReady(items) {
  if (items.every((x) => x.ready)) return "ready";
  if (items.some((x) => x.ready)) return "partial";
  return "missing";
}

function productionReadiness(groups) {
  const byId = new Map(groups.flatMap((group) => group.items.map((it) => [it.id, it])));
  const itemReady = (id) => !!byId.get(id)?.ready;
  const repoApplyReady = itemReady("github_oauth") || itemReady("github_app_manifest");
  const lanes = [
    {
      id: "revenue",
      label: "Credits + PromptPay revenue",
      ready: itemReady("entitlements_kv") && itemReady("stripe") && itemReady("stripe_webhook") && itemReady("promptpay"),
      required_items: ["entitlements_kv", "stripe", "stripe_webhook", "promptpay"],
    },
    {
      id: "proof_loop",
      label: "Proof loop with screenshot evidence",
      ready: itemReady("proof_kv") && itemReady("browser_rendering"),
      required_items: ["proof_kv", "browser_rendering"],
    },
    {
      id: "agent_handoff",
      label: "Hermes-style agent handoff",
      ready: itemReady("agent_store") && itemReady("agent_token_secret"),
      required_items: ["agent_store", "agent_token_secret"],
    },
    {
      id: "repo_apply",
      label: "GitHub repo apply lane",
      ready: repoApplyReady,
      required_items: repoApplyReady ? [] : ["github_oauth", "github_app_manifest"],
    },
    {
      id: "performance_verification",
      label: "Verified PageSpeed/Core Web Vitals",
      ready: itemReady("pagespeed") && itemReady("pagespeed_cache"),
      required_items: ["pagespeed", "pagespeed_cache"],
    },
  ].map((lane) => ({
    ...lane,
    status: lane.ready ? "ready" : "needs_setup",
    missing_items: lane.id === "repo_apply" && !repoApplyReady
      ? ["github_oauth_or_github_app_manifest"]
      : lane.required_items.filter((id) => !itemReady(id)),
  }));
  const coreLive = lanes.filter((lane) => ["revenue", "proof_loop", "agent_handoff"].includes(lane.id)).every((lane) => lane.ready);
  const coreRequirements = [
    {
      id: "storage",
      label: "Storage and abuse control",
      ready: itemReady("entitlements_kv") && itemReady("proof_kv") && itemReady("rate_limit_kv"),
      missing_items: ["entitlements_kv", "proof_kv", "rate_limit_kv"].filter((id) => !itemReady(id)),
    },
    {
      id: "auth",
      label: "Google login plus official repo approval",
      ready: itemReady("session_secret") && itemReady("google_oauth") && repoApplyReady,
      missing_items: [
        ...(["session_secret", "google_oauth"].filter((id) => !itemReady(id))),
        ...(!repoApplyReady ? ["github_oauth_or_github_app_manifest"] : []),
      ],
    },
    {
      id: "payments",
      label: "Credits and PromptPay",
      ready: itemReady("stripe") && itemReady("stripe_webhook") && itemReady("promptpay"),
      missing_items: ["stripe", "stripe_webhook", "promptpay"].filter((id) => !itemReady(id)),
    },
    {
      id: "proof",
      label: "Proof baseline and screenshot evidence",
      ready: itemReady("proof_kv") && itemReady("browser_rendering"),
      missing_items: ["proof_kv", "browser_rendering"].filter((id) => !itemReady(id)),
    },
    {
      id: "agent",
      label: "Hermes-style agent bridge",
      ready: itemReady("agent_store") && itemReady("agent_token_secret"),
      missing_items: ["agent_store", "agent_token_secret"].filter((id) => !itemReady(id)),
    },
  ].map((req) => ({ ...req, status: req.ready ? "ready" : "needs_setup" }));
  const missing = coreRequirements.filter((req) => !req.ready).map((req) => req.id);
  const optionalLaneMissing = lanes.filter((lane) => !lane.ready).map((lane) => lane.id);
  const allProductionReady = missing.length === 0 && optionalLaneMissing.length === 0;
  return {
    status: missing.length ? "needs_setup" : (optionalLaneMissing.length ? "core_ready_needs_optional_setup" : "ready"),
    ready: allProductionReady,
    core_live_ready: coreLive,
    lanes,
    core_requirements: coreRequirements,
    missing_required_groups: missing,
    optional_missing_lanes: optionalLaneMissing,
    note: missing.length
      ? "Core setup is still missing. Fix the missing core requirement groups before relying on the live product."
      : (optionalLaneMissing.length
        ? "Core live flows are configured. Optional/advanced lanes still need setup before claiming full production completion."
        : "All tracked production lanes are configured. Run live payment, agent, and proof smoke tests before claiming end-to-end completion."),
  };
}

function productionRunbook(production, groups) {
  const byItem = new Map(groups.flatMap((group) => group.items.map((it) => [it.id, { ...it, group_id: group.id, group_label: group.label }])));
  const seen = new Set();
  const addAction = (id, priority, lane = "") => {
    if (seen.has(id)) return;
    seen.add(id);
    const it = byItem.get(id);
    if (!it || it.ready) return;
    const action = {
      id,
      priority,
      lane,
      title: it.label || id,
      status: it.status || "missing",
      why: it.detail || "",
      setup: it.setup || "Configure this in Cloudflare Pages.",
      group: it.group_label || it.group_id || "",
    };
    if (id === "pagespeed") {
      action.why = "Needed only for verified PageSpeed/Core Web Vitals at production scale. AI Mark still provides Performance Lite evidence without it.";
      action.setup = "Enable PageSpeed Insights API in Google Cloud, create an API key, set GOOGLE_PSI_KEY in Cloudflare Pages, then redeploy and run npm run verify:production.";
    }
    if (id === "pagespeed_cache") {
      action.setup = "Bind PROOF_KV, RATE_LIMIT_KV, or ENTITLEMENTS_KV so repeated scans cache PSI results and quota errors.";
    }
    if (id === "browser_rendering") {
      action.setup = "Set CF_ACCOUNT_ID and BROWSER_API_TOKEN with Cloudflare Browser Rendering permission, then run proof smoke.";
    }
    return action;
  };

  const nextActions = [];
  for (const req of production.core_requirements || []) {
    for (const id of req.missing_items || []) {
      const action = addAction(id, "core", req.id);
      if (action) nextActions.push(action);
    }
  }
  for (const lane of production.lanes || []) {
    if (lane.ready) continue;
    for (const id of lane.missing_items || []) {
      if (id === "github_oauth_or_github_app_manifest") continue;
      const action = addAction(id, production.core_live_ready ? "optional" : "core", lane.id);
      if (action) nextActions.push(action);
    }
  }

  return {
    status: production.ready ? "ready" : (production.core_live_ready ? "core_ready_with_optional_actions" : "core_setup_required"),
    operator_summary: production.ready
      ? "All tracked lanes are configured. Keep running the production verification gate before and after deploys."
      : (production.core_live_ready
        ? "Core live flows are configured. Close optional actions before claiming full production completion."
        : "Core setup is missing. Do not rely on the live product until core actions are closed."),
    verification_commands: [
      {
        label: "Local production gate",
        shell: "PowerShell",
        command: "cd web; npm run verify:production",
        purpose: "Runs syntax checks, API smoke, bridge E2E, Python audits, npm audit, and production smoke in one command.",
      },
      {
        label: "Deploy then verify",
        shell: "PowerShell",
        command: "cd web; npm run deploy; npm run verify:production",
        purpose: "Deploys Cloudflare Pages and verifies the production URL after deployment.",
      },
      {
        label: "Local-only gate",
        shell: "PowerShell",
        command: "cd web; npm run verify:local",
        purpose: "Runs local syntax/tests/audit without external production smoke.",
      },
    ],
    next_actions: nextActions,
    smoke_checks: [
      "Google login session",
      "PromptPay/Stripe checkout and webhook credit posting",
      "Agent Bridge pair, poll, progress, result",
      "Proof screenshot render",
      "Scan with PSI available and with PSI quota unavailable",
    ],
  };
}

export async function onRequestGet({ env }) {
  const browserTokenSource = firstPresent(env, [
    "BROWSER_API_TOKEN",
    "Render_CF_KEY",
    "RENDER_CF_KEY",
    "CF_BROWSER_RENDERING_TOKEN",
    "CF_API_TOKEN",
  ]);
  const llmProviderSource = firstPresent(env, ["ANTHROPIC_API_KEY", "GROQ_API_KEY", "KIMI_API_KEY"]);
  const citationProviderSource = firstPresent(env, ["GEMINI_API_KEY", "PERPLEXITY_API_KEY", "SERPAPI_KEY", "TAVILY_API_KEY"]);
  const leadProviderSource = firstPresent(env, ["SERPAPI_KEY", "TAVILY_API_KEY"]);
  const pageSpeedCacheSource = firstPresent(env, ["PROOF_KV", "RATE_LIMIT_KV", "ENTITLEMENTS_KV"]);

  const groups = [
    {
      id: "storage",
      label: "Storage and ledgers",
      items: [
        item("entitlements_kv", "ENTITLEMENTS_KV", present(env.ENTITLEMENTS_KV), "Stores credits, OAuth records, and fallback agent state.", "Bind ENTITLEMENTS_KV in Cloudflare Pages."),
        item("proof_kv", "PROOF_KV", present(env.PROOF_KV), "Stores before/after proof baselines and public proof links.", "Bind PROOF_KV in Cloudflare Pages."),
        item("rate_limit_kv", "RATE_LIMIT_KV", present(env.RATE_LIMIT_KV), "Stores public scan rate limits.", "Bind RATE_LIMIT_KV for production abuse control."),
      ],
    },
    {
      id: "auth",
      label: "Login and repo OAuth",
      items: [
        item("session_secret", "AUTH_SESSION_SECRET", present(env.AUTH_SESSION_SECRET || env.PAID_EXPORT_SECRET), "Signs AI Mark user and agent sessions.", "Set AUTH_SESSION_SECRET."),
        item("google_oauth", "Google OAuth", present(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), "Lets users sign in and attach credits to their account.", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."),
        item("github_oauth", "GitHub OAuth", present(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET), "Optional OAuth lane for users who connect GitHub directly.", "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET."),
        item("github_app_manifest", "GitHub App manifest flow", present((env.AUTH_SESSION_SECRET || env.PAID_EXPORT_SECRET) && env.ENTITLEMENTS_KV), "Lets repo owners approve a GitHub App without pasting tokens; AI Mark can then open PRs.", "Bind ENTITLEMENTS_KV and set AUTH_SESSION_SECRET."),
      ],
    },
    {
      id: "payments",
      label: "Credits and PromptPay",
      items: [
        item("stripe", "Stripe Checkout", present(env.STRIPE_SECRET_KEY), "Creates live checkout sessions for credit packs.", "Set STRIPE_SECRET_KEY."),
        item("stripe_webhook", "Stripe webhook", present(env.STRIPE_WEBHOOK_SECRET), "Records successful payments authoritatively.", "Set STRIPE_WEBHOOK_SECRET and point Stripe to /api/checkout/webhook."),
        item("promptpay", "PromptPay QR", present(env.STRIPE_SECRET_KEY && String(env.CHECKOUT_CURRENCY || "").toLowerCase() === "thb"), "Enables Thai PromptPay QR through Stripe Checkout.", "Set CHECKOUT_CURRENCY=thb and enable PromptPay in Stripe."),
      ],
    },
    {
      id: "proof",
      label: "Proof loop evidence",
      items: [
        item("browser_rendering", "Browser Rendering", present(env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID) && present(browserTokenSource), "Captures proof screenshots and human-vs-AI render evidence.", "Set CF_ACCOUNT_ID and BROWSER_API_TOKEN with Browser Rendering: Edit.", { token_source: browserTokenSource || "" }),
        item("citation_probe", "Live citation providers", present(citationProviderSource), "Checks if AI/search providers mention the target brand.", "Set GEMINI_API_KEY, PERPLEXITY_API_KEY, SERPAPI_KEY, or TAVILY_API_KEY.", { provider_source: citationProviderSource || "" }),
        item("performance_lite", "AI Mark Performance Lite", true, "Built-in low-resource public evidence: fetch time, HTML size, compression/cache headers, resource hints, and asset counts. This does not replace Core Web Vitals.", ""),
        item("pagespeed", "PageSpeed Insights API key", present(env.GOOGLE_PSI_KEY), "Verifies Core Web Vitals with your own Google Cloud project quota. Without a key, Google still allows best-effort calls, but frequent automated scans are not reliable.", "Enable PageSpeed Insights API in Google Cloud, create an API key, set GOOGLE_PSI_KEY, then monitor or request quota in Google Cloud Quotas.", { mode: env.GOOGLE_PSI_KEY ? "keyed" : "anonymous_best_effort" }),
        item("pagespeed_cache", "PageSpeed cache", present(pageSpeedCacheSource), "Caches successful PSI results per URL for 24 hours and short quota errors for 10 minutes so repeat scans do not burn quota.", "Bind PROOF_KV (preferred), RATE_LIMIT_KV, or ENTITLEMENTS_KV.", { provider_source: pageSpeedCacheSource || "" }),
      ],
    },
    {
      id: "agent",
      label: "Agent bridge",
      items: [
        item("agent_store", "AGENT_DB or AGENT_KV", present(env.AGENT_DB || env.AGENT_KV || env.ENTITLEMENTS_KV), "Stores paired bridge devices, queues, progress, and results.", "Bind AGENT_DB or AGENT_KV; ENTITLEMENTS_KV can act as fallback."),
        item("agent_token_secret", "Agent token signing", present(env.AUTH_SESSION_SECRET || env.PAID_EXPORT_SECRET), "Signs secure bridge tokens for Hermes-style polling.", "Set AUTH_SESSION_SECRET."),
      ],
    },
    {
      id: "growth",
      label: "Lead scout and LLM synthesis",
      items: [
        item("lead_discovery", "Lead discovery provider", present(leadProviderSource), "Finds qualified SME prospects from public search.", "Set SERPAPI_KEY or TAVILY_API_KEY.", { provider_source: leadProviderSource || "" }),
        item("llm_synthesis", "Cloud LLM fallback", present(llmProviderSource), "Synthesizes scan/improve output when local agent is not connected.", "Set ANTHROPIC_API_KEY, GROQ_API_KEY, or KIMI_API_KEY.", { provider_source: llmProviderSource || "" }),
      ],
    },
  ].map((group) => ({ ...group, status: groupReady(group.items), ready: group.items.every((x) => x.ready) }));

  const production = productionReadiness(groups);
  return json({
    status: "ok",
    generated_at: new Date().toISOString(),
    production,
    runbook: productionRunbook(production, groups),
    groups,
    safe: {
      secrets_redacted: true,
      exposes_secret_values: false,
    },
  });
}
