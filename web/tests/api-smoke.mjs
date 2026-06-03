import assert from "node:assert/strict";
import { onRequestPost as lineOaKit } from "../functions/api/line-oa-kit.js";
import { onRequestPost as renderCheck } from "../functions/api/render-check.js";
import { onRequestPost as scanSite } from "../functions/api/scan.js";
import { onRequestPost as leadScout } from "../functions/api/lead-scout.js";
import { onRequestPost as exportPackage } from "../functions/api/export-package.js";
import { onRequestPost as deployApply } from "../functions/api/deploy.js";
import { onRequestGet as proofGet, onRequestPost as proofPost } from "../functions/api/proof.js";
import { onRequestGet as checkoutGet, onRequestPost as checkoutPost } from "../functions/api/checkout.js";
import { onRequestGet as systemHealth } from "../functions/api/system-health.js";
import { onRequestGet as botIntelHistory, onRequestPost as botIntel } from "../functions/api/bot-intel.js";
import { paidStatus, signSession } from "../functions/api/_auth.js";
import { onRequestGet as authMe } from "../functions/api/auth/me.js";
import { onRequestPost as startAgentPair } from "../functions/api/agent/pair/device/start.js";
import { onRequestPost as approveAgentPair } from "../functions/api/agent/pair/approve.js";
import { onRequestPost as claimAgentPairToken } from "../functions/api/agent/pair/token.js";
import { onRequestPost as agentHeartbeat } from "../functions/api/agent/heartbeat.js";
import { onRequestPost as enqueueAgentJob } from "../functions/api/agent/jobs.js";
import { onRequestGet as pollAgentJob } from "../functions/api/agent/jobs/poll.js";
import { onRequestPost as postAgentJobProgress } from "../functions/api/agent/jobs/progress.js";
import { onRequestPost as postAgentJobResult } from "../functions/api/agent/jobs/result.js";
import { jobProgress, onRequestGet as getAgentJobStatus } from "../functions/api/agent/jobs/status.js";
import { agentQueueKey, signAgentToken } from "../functions/api/_agent.js";
import { onRequestGet as listSkillsApi } from "../functions/api/skills.js";
import { creditCost } from "../functions/api/_credits.js";
import { getSkill, skillCapabilities, skillCreditCost } from "../functions/api/_skills.js";
import { onRequestPost as conversionAudit, analyzeConversion } from "../functions/api/conversion-audit.js";
import { onRequestPost as localSeoAudit, analyzeLocalSeo } from "../functions/api/local-seo-audit.js";
import { onRequestPost as techAudit, analyzeTech } from "../functions/api/tech-audit.js";
import { toolDefinitions, executeTool, resolveToolId } from "../functions/api/_tools.js";
import { onRequestPost as mcpPost } from "../functions/api/mcp.js";

async function post(handler, body, { env = {}, headers = {}, url = "https://aimark.pages.dev/api/test" } = {}) {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const response = await handler({ request, env });
  const data = await response.json();
  return { status: response.status, data };
}

async function get(handler, { env = {}, headers = {}, url = "https://aimark.pages.dev/api/test" } = {}) {
  const request = new Request(url, { method: "GET", headers });
  const response = await handler({ request, env });
  const data = await response.json();
  return { status: response.status, data };
}

function assertNoLineSecretFields(data) {
  const text = JSON.stringify(data);
  assert.equal(/line_channel_access_token/i.test(text), false, "must not expose a LINE channel access token field");
  assert.equal(/channel_secret/i.test(text), false, "must not expose a LINE channel secret field");
  assert.equal(/password/i.test(text), false, "must not ask for a password");
  assert.match(text, /dry_run/i, "LINE OA handoff must require dry_run before outbound sending");
}

async function testLineOaPreview() {
  const { status, data } = await post(lineOaKit, {
    url: "https://successcasting.com",
    brand: "Success Casting",
    lang: "th",
  });
  assert.equal(status, 200);
  assert.equal(data.paid, false);
  assert.equal(data.status, "preview");
  assert.equal(data.upgrade.required, true);
  assert.equal(data.kit.broadcast_drafts.length, 2);
  assert.ok(data.kit.locked_fields.includes("agent_handoff_execution"));
  assert.match(data.kit.security_policy, /ไม่ขอ LINE token/i);
  assertNoLineSecretFields(data);
}

async function testLineOaPaidFullKit() {
  const { status, data } = await post(lineOaKit, {
    url: "https://successcasting.com",
    business: "Success Casting",
    lang: "th",
  }, {
    env: { PAID_EXPORT_API_TOKEN: "paid-test" },
    headers: { authorization: "Bearer paid-test" },
  });
  assert.equal(status, 200);
  assert.equal(data.paid, true);
  assert.equal(data.status, "full");
  assert.equal(data.kit.broadcast_drafts.length, 6);
  assert.equal(data.kit.rich_menu.areas.length, 6);
  assert.equal(data.kit.locked_fields.length, 0);
  assert.match(data.markdown, /line-oa-mcp-ultimate/);
  assert.match(data.markdown, /owner confirmation|owner approval|อนุมัติ/i);
  assertNoLineSecretFields(data);
}

async function testCreditBalanceUnlocksPaidFeaturesWithoutPaidCookie() {
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "credit-session-secret", ENTITLEMENTS_KV: kv };
  const { token } = await signSession({
    sid: "sid_credit_user",
    provider: "google",
    email: "creditbuyer@example.com",
    name: "Credit Buyer",
  }, env.AUTH_SESSION_SECRET);
  await kv.put("credits:email:creditbuyer@example.com", JSON.stringify({
    email: "creditbuyer@example.com",
    balance: 500,
    lifetime_purchased: 500,
    last_product: "credits_5",
    last_session_id: "cs_credit_unlock",
    updated_at: "2026-06-02T00:00:00.000Z",
  }));
  const headers = { cookie: `aimark_session=${token}` };

  const statusReq = new Request("https://aimark.pages.dev/api/test", { headers });
  const status = await paidStatus(statusReq, env, "locked");
  assert.equal(status.paid, true);
  assert.equal(status.reason, "credit_balance");
  assert.equal(status.credits.balance, 500);

  const unsignedUser = encodeURIComponent(JSON.stringify({ email: "creditbuyer@example.com" }));
  const forgedReq = new Request("https://aimark.pages.dev/api/test", { headers: { cookie: `aimark_user=${unsignedUser}` } });
  const forged = await paidStatus(forgedReq, env, "locked");
  assert.equal(forged.paid, false, "unsigned display-only user cookie must not unlock paid features");
  assert.equal(forged.reason, "locked");

  const fullKit = await post(lineOaKit, {
    url: "https://successcasting.com",
    brand: "Success Casting",
    lang: "th",
  }, {
    env,
    headers,
    url: "https://aimark.pages.dev/api/line-oa-kit",
  });
  assert.equal(fullKit.status, 200);
  assert.equal(fullKit.data.paid, true);
  assert.equal(fullKit.data.status, "full");
  assert.equal(fullKit.data.paid_reason, "credit_balance");
  assert.equal(fullKit.data.credit_charge.charged, true);
  assert.equal(fullKit.data.credit_charge.amount, 100);
  assert.equal(fullKit.data.credit_charge.balance, 400);
  assert.equal(fullKit.data.kit.locked_fields.length, 0);
  assert.equal(fullKit.data.kit.broadcast_drafts.length, 6);

  const balanceAfter = await kv.get("credits:email:creditbuyer@example.com", "json");
  assert.equal(balanceAfter.balance, 400);
  assert.equal(balanceAfter.lifetime_spent, 100);
  const me = await get(authMe, {
    env,
    headers,
    url: "https://aimark.pages.dev/api/auth/me",
  });
  assert.equal(me.status, 200);
  assert.equal(me.data.credits.balance, 400);
  assert.equal(me.data.credits.lifetime_spent, 100);
  assert.equal(me.data.credits.recent_ledger.length, 1);
  assert.equal(me.data.credits.recent_ledger[0].feature, "line_oa_growth_kit");

  const repeatKit = await post(lineOaKit, {
    url: "https://successcasting.com",
    brand: "Success Casting",
    lang: "th",
  }, {
    env,
    headers,
    url: "https://aimark.pages.dev/api/line-oa-kit",
  });
  assert.equal(repeatKit.status, 200);
  assert.equal(repeatKit.data.credit_charge.already_charged, true);
  assert.equal(repeatKit.data.credit_charge.balance, 400);
  const balanceRepeat = await kv.get("credits:email:creditbuyer@example.com", "json");
  assert.equal(balanceRepeat.balance, 400, "same LINE OA kit URL must not debit twice");

  const poorKv = memoryKv();
  const poorEnv = { AUTH_SESSION_SECRET: "credit-session-secret", ENTITLEMENTS_KV: poorKv };
  await poorKv.put("credits:email:creditbuyer@example.com", JSON.stringify({
    email: "creditbuyer@example.com",
    balance: 50,
    lifetime_purchased: 50,
  }));
  const insufficient = await post(lineOaKit, {
    url: "https://anotherbrand.example",
    brand: "Another Brand",
    lang: "th",
  }, {
    env: poorEnv,
    headers,
    url: "https://aimark.pages.dev/api/line-oa-kit",
  });
  assert.equal(insufficient.status, 402);
  assert.equal(insufficient.data.error, "insufficient_credits");
  assert.equal(insufficient.data.credits_required, 100);
  assert.equal(insufficient.data.credits_balance, 50);
  assert.equal(insufficient.data.credits_needed, 50);
}

async function testRenderCheckDebitsCreditsAndRejectsInsufficientBalance() {
  const { token } = await signSession({
    sid: "sid_render_user",
    provider: "google",
    email: "renderbuyer@example.com",
    name: "Render Buyer",
  }, "render-secret");
  const headers = { cookie: `aimark_session=${token}` };

  const poorKv = memoryKv();
  await poorKv.put("credits:email:renderbuyer@example.com", JSON.stringify({
    email: "renderbuyer@example.com",
    balance: 25,
    lifetime_purchased: 25,
  }));
  await withMockFetch(async () => {
    throw new Error("Browser rendering should not be called when credits are insufficient.");
  }, async () => {
    const insufficient = await post(renderCheck, {
      url: "https://spa.example/",
      screenshot: false,
    }, {
      env: {
        AUTH_SESSION_SECRET: "render-secret",
        ENTITLEMENTS_KV: poorKv,
        CF_ACCOUNT_ID: "acct",
        BROWSER_API_TOKEN: "token",
      },
      headers,
      url: "https://aimark.pages.dev/api/render-check",
    });
    assert.equal(insufficient.status, 402);
    assert.equal(insufficient.data.error, "insufficient_credits");
    assert.equal(insufficient.data.credits_required, 75);
    assert.equal(insufficient.data.credits_balance, 25);
  });

  const kv = memoryKv();
  await kv.put("credits:email:renderbuyer@example.com", JSON.stringify({
    email: "renderbuyer@example.com",
    balance: 100,
    lifetime_purchased: 100,
  }));
  let browserCalls = 0;
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url === "https://spa.example/") {
      return response("<html><body><div id='root'></div><script>render()</script></body></html>");
    }
    if (url.includes("/browser-rendering/content")) {
      browserCalls += 1;
      return new Response(JSON.stringify({
        success: true,
        result: `<html><body>${"human visible service faq quote ".repeat(80)}</body></html>`,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const env = {
      AUTH_SESSION_SECRET: "render-secret",
      ENTITLEMENTS_KV: kv,
      CF_ACCOUNT_ID: "acct",
      BROWSER_API_TOKEN: "token",
    };
    const first = await post(renderCheck, {
      url: "https://spa.example/",
      screenshot: false,
    }, { env, headers, url: "https://aimark.pages.dev/api/render-check" });
    assert.equal(first.status, 200);
    assert.equal(first.data.live, true);
    assert.equal(first.data.paid_reason, "credit_balance");
    assert.equal(first.data.credit_charge.charged, true);
    assert.equal(first.data.credit_charge.amount, 75);
    assert.equal(first.data.credit_charge.balance, 25);

    const second = await post(renderCheck, {
      url: "https://spa.example/",
      screenshot: false,
    }, { env, headers, url: "https://aimark.pages.dev/api/render-check" });
    assert.equal(second.status, 200);
    assert.equal(second.data.credit_charge.already_charged, true);
    assert.equal(second.data.credit_charge.balance, 25);
    assert.equal(browserCalls, 2, "idempotency prevents duplicate debit, not the requested re-check itself");
    const balance = await kv.get("credits:email:renderbuyer@example.com", "json");
    assert.equal(balance.balance, 25);
    assert.equal(balance.lifetime_spent, 75);
  });

  const authFailKv = memoryKv();
  await authFailKv.put("credits:email:renderbuyer@example.com", JSON.stringify({
    email: "renderbuyer@example.com",
    balance: 100,
    lifetime_purchased: 100,
  }));
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url === "https://badtoken.example/") {
      return response("<html><body>Public landing page</body></html>");
    }
    if (url.includes("/browser-rendering/content")) {
      return new Response(JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      }), { status: 401, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const env = {
      AUTH_SESSION_SECRET: "render-secret",
      ENTITLEMENTS_KV: authFailKv,
      CF_ACCOUNT_ID: "acct",
      BROWSER_API_TOKEN: "token",
    };
    const unauthorized = await post(renderCheck, {
      url: "https://badtoken.example/",
      screenshot: false,
    }, { env, headers, url: "https://aimark.pages.dev/api/render-check" });
    assert.equal(unauthorized.status, 200);
    assert.equal(unauthorized.data.error, "browser_rendering_unauthorized");
    assert.equal(unauthorized.data.credit_charge, null);
    assert.match(unauthorized.data.setup_required, /BROWSER_API_TOKEN.*401/i);
    assert.equal(unauthorized.data.diagnostic.token_source, "BROWSER_API_TOKEN");
    const balance = await authFailKv.get("credits:email:renderbuyer@example.com", "json");
    assert.equal(balance.balance, 100, "Browser Rendering auth failure must not debit credits");
    assert.equal(balance.lifetime_spent || 0, 0);
  });
}

function samplePaidScan() {
  return {
    url: "https://client.example/",
    overall: 64,
    grade: "C",
    summary: "Needs AI/search visibility fixes.",
    categories: [
      {
        name: "AI Search / GEO-AEO",
        findings: [
          { status: "fail", severity: "high", check: "FAQ / answer-led content", detail: "No buyer FAQ", fix: "Add FAQPage and visible FAQ answers." },
        ],
      },
    ],
  };
}

function sampleArtifacts() {
  return {
    robots_txt: { code: "User-agent: *\nAllow: /\n" },
    llms_txt: { code: "# Client\n\nServices and contact." },
    head_block: { code: "<title>Client</title><meta name=\"description\" content=\"Client services\">" },
    json_ld: { code: "<script type=\"application/ld+json\">{\"@context\":\"https://schema.org\"}</script>" },
    faq_block: { code: "<section><h2>FAQ</h2><p>Answer.</p></section>" },
  };
}

async function testExportPackageAndDeployDebitCreditsIdempotently() {
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "package-secret", ENTITLEMENTS_KV: kv };
  const { token } = await signSession({
    sid: "sid_package_user",
    provider: "google",
    email: "packagebuyer@example.com",
    name: "Package Buyer",
  }, env.AUTH_SESSION_SECRET);
  const headers = { cookie: `aimark_session=${token}` };
  await kv.put("credits:email:packagebuyer@example.com", JSON.stringify({
    email: "packagebuyer@example.com",
    balance: 500,
    lifetime_purchased: 500,
  }));

  const exported = await post(exportPackage, {
    type: "bundle",
    scan: samplePaidScan(),
  }, { env, headers, url: "https://aimark.pages.dev/api/export-package" });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.export_allowed, true);
  assert.equal(exported.data.export_reason, "credit_balance");
  assert.equal(exported.data.credit_charge.charged, true);
  assert.equal(exported.data.credit_charge.amount, 100);
  assert.equal(exported.data.credit_charge.balance, 400);

  const exportedAgain = await post(exportPackage, {
    type: "bundle",
    scan: samplePaidScan(),
  }, { env, headers, url: "https://aimark.pages.dev/api/export-package" });
  assert.equal(exportedAgain.status, 200);
  assert.equal(exportedAgain.data.credit_charge.already_charged, true);
  assert.equal(exportedAgain.data.credit_charge.balance, 400);

  const deployed = await post(deployApply, {
    provider: "bundle",
    origin_url: "https://client.example",
    artifacts: sampleArtifacts(),
  }, { env, headers, url: "https://aimark.pages.dev/api/deploy" });
  assert.equal(deployed.status, 200);
  assert.equal(deployed.data.status, "bundle_ready");
  assert.equal(deployed.data.paid_reason, "credit_balance");
  assert.equal(deployed.data.credit_charge.charged, true);
  assert.equal(deployed.data.credit_charge.amount, 150);
  assert.equal(deployed.data.credit_charge.balance, 250);
  assert.equal(deployed.data.proof_plan.status, "ready");
  assert.equal(deployed.data.proof_plan.provider, "bundle");
  assert.equal(deployed.data.proof_plan.site_url, "https://client.example/");
  assert.match(deployed.data.proof_plan.proof_endpoint, /\/api\/proof\?url=/);
  assert.ok(deployed.data.proof_plan.checklist.th.some((item) => item.includes("Proof")));
  assert.ok(deployed.data.proof_plan.expected_public_files.some((item) => item.file === "robots.txt" && item.url === "https://client.example/robots.txt"));
  assert.ok(deployed.data.proof_plan.expected_public_files.some((item) => item.file === "llms.txt" && item.url === "https://client.example/llms.txt"));
  assert.equal(deployed.data.proof_plan.merge_or_publish_required, false);

  const deployedAgain = await post(deployApply, {
    provider: "bundle",
    origin_url: "https://client.example",
    artifacts: sampleArtifacts(),
  }, { env, headers, url: "https://aimark.pages.dev/api/deploy" });
  assert.equal(deployedAgain.status, 200);
  assert.equal(deployedAgain.data.credit_charge.already_charged, true);
  assert.equal(deployedAgain.data.credit_charge.balance, 250);

  const noFiles = await post(deployApply, {
    provider: "bundle",
    origin_url: "https://client.example",
    artifacts: {},
  }, { env, headers, url: "https://aimark.pages.dev/api/deploy" });
  assert.equal(noFiles.status, 400);
  const balanceAfterNoFiles = await kv.get("credits:email:packagebuyer@example.com", "json");
  assert.equal(balanceAfterNoFiles.balance, 250, "validation failure must not debit credits");

  const ledger = await kv.get("credit:ledger:packagebuyer@example.com", "json");
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].feature, "export_package");
  assert.equal(ledger[1].feature, "deploy_apply");
}

function htmlPage({ title = "ABC Dental Clinic Bangkok | Contact", words = 720 } = {}) {
  const text = Array(words).fill("dental clinic Bangkok service quote contact FAQ updated 2026 customer review").join(" ");
  return `<!doctype html><html lang="th"><head>
    <title>${title}</title>
    <meta name="description" content="ABC Dental Clinic in Bangkok offers dental services, appointments, quotes, reviews, and direct contact for Thai customers.">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="canonical" href="https://abcclinic.test/">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="Book dental service and request a quote from ABC Dental Clinic Bangkok.">
    <meta property="og:image" content="https://abcclinic.test/og.jpg">
    <meta name="twitter:card" content="summary_large_image">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"ABC Dental Clinic"}</script>
  </head><body><h1>ABC Dental Clinic Bangkok</h1><p>${text}</p><h2>FAQ</h2><p>How to book? Contact LINE or phone for appointment and quote.</p></body></html>`;
}

function response(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function withMockFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await fn(); }
  finally { globalThis.fetch = original; }
}

function memoryKv() {
  const map = new Map();
  return {
    async get(key, type = "text") {
      const value = map.get(String(key)) || null;
      if (value == null) return null;
      if (type === "json") {
        try { return JSON.parse(value); } catch { return null; }
      }
      return value;
    },
    async put(key, value) { map.set(String(key), String(value)); },
    async delete(key) { map.delete(String(key)); },
  };
}

async function testSystemHealthReportsReadinessWithoutLeakingSecrets() {
  const readyEnv = {
    RATE_LIMIT_KV: memoryKv(),
    ENTITLEMENTS_KV: memoryKv(),
    PROOF_KV: memoryKv(),
    AGENT_DB: {},
    AUTH_SESSION_SECRET: "auth-secret-should-not-leak",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-secret-should-not-leak",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-secret-should-not-leak",
    STRIPE_SECRET_KEY: "sk_live_secret_should_not_leak",
    STRIPE_WEBHOOK_SECRET: "whsec_should_not_leak",
    CHECKOUT_CURRENCY: "thb",
    CF_ACCOUNT_ID: "cf-account-id",
    BROWSER_API_TOKEN: "browser-token-should-not-leak",
    GEMINI_API_KEY: "gemini-secret-should-not-leak",
    SERPAPI_KEY: "serp-secret-should-not-leak",
    ANTHROPIC_API_KEY: "anthropic-secret-should-not-leak",
    GOOGLE_PSI_KEY: "psi-secret-should-not-leak",
  };
  const ready = await get(systemHealth, { env: readyEnv, url: "https://aimark.pages.dev/api/system-health" });
  assert.equal(ready.status, 200);
  assert.equal(ready.data.production.ready, true);
  assert.equal(ready.data.production.core_live_ready, true);
  assert.equal(ready.data.runbook.status, "ready");
  assert.ok(ready.data.runbook.verification_commands.some((x) => /verify:production/.test(x.command)));
  assert.equal(ready.data.production.lanes.find((x) => x.id === "repo_apply").ready, true);
  assert.equal(ready.data.production.lanes.find((x) => x.id === "performance_verification").ready, true);
  assert.equal(ready.data.safe.exposes_secret_values, false);
  const proof = ready.data.groups.find((g) => g.id === "proof");
  assert.equal(proof.status, "ready");
  assert.equal(proof.items.find((x) => x.id === "browser_rendering").token_source, "BROWSER_API_TOKEN");
  assert.equal(proof.items.find((x) => x.id === "performance_lite").ready, true);
  assert.equal(proof.items.find((x) => x.id === "pagespeed").ready, true);
  assert.equal(proof.items.find((x) => x.id === "pagespeed_cache").ready, true);
  const payments = ready.data.groups.find((g) => g.id === "payments");
  assert.equal(payments.status, "ready");
  assert.equal(payments.items.find((x) => x.id === "promptpay").ready, true);

  const appOnlyEnv = {
    RATE_LIMIT_KV: memoryKv(),
    ENTITLEMENTS_KV: memoryKv(),
    PROOF_KV: memoryKv(),
    AUTH_SESSION_SECRET: "auth-secret-should-not-leak",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-secret-should-not-leak",
    STRIPE_SECRET_KEY: "sk_live_secret_should_not_leak",
    STRIPE_WEBHOOK_SECRET: "whsec_should_not_leak",
    CHECKOUT_CURRENCY: "thb",
    CF_ACCOUNT_ID: "cf-account-id",
    BROWSER_API_TOKEN: "browser-token-should-not-leak",
    SERPAPI_KEY: "serp-secret-should-not-leak",
    ANTHROPIC_API_KEY: "anthropic-secret-should-not-leak",
  };
  const appOnly = await get(systemHealth, { env: appOnlyEnv, url: "https://aimark.pages.dev/api/system-health" });
  assert.equal(appOnly.status, 200);
  assert.equal(appOnly.data.production.status, "core_ready_needs_optional_setup");
  assert.equal(appOnly.data.production.ready, false);
  assert.equal(appOnly.data.production.core_live_ready, true);
  assert.equal(appOnly.data.runbook.status, "core_ready_with_optional_actions");
  assert.ok(appOnly.data.runbook.next_actions.some((x) => x.id === "pagespeed" && x.priority === "optional"));
  assert.ok(appOnly.data.runbook.next_actions.find((x) => x.id === "pagespeed").setup.includes("GOOGLE_PSI_KEY"));
  assert.deepEqual(appOnly.data.production.missing_required_groups, []);
  assert.ok(appOnly.data.production.optional_missing_lanes.includes("performance_verification"));
  assert.equal(appOnly.data.production.core_requirements.find((x) => x.id === "auth").ready, true);
  assert.equal(appOnly.data.production.core_requirements.find((x) => x.id === "proof").ready, true);
  assert.equal(appOnly.data.production.lanes.find((x) => x.id === "repo_apply").ready, true);
  assert.equal(appOnly.data.production.lanes.find((x) => x.id === "performance_verification").ready, false);
  assert.ok(appOnly.data.production.lanes.find((x) => x.id === "performance_verification").missing_items.includes("pagespeed"));
  assert.equal(appOnly.data.groups.find((g) => g.id === "auth").items.find((x) => x.id === "github_oauth").ready, false);
  assert.equal(appOnly.data.groups.find((g) => g.id === "auth").items.find((x) => x.id === "github_app_manifest").ready, true);
  assert.equal(appOnly.data.groups.find((g) => g.id === "proof").items.find((x) => x.id === "performance_lite").ready, true);
  assert.equal(appOnly.data.groups.find((g) => g.id === "auth").status, "partial", "group can stay partial while core auth is ready via GitHub App manifest");
  assert.equal(appOnly.data.groups.find((g) => g.id === "proof").status, "partial", "group can stay partial while core proof is ready without PageSpeed key");

  const serialized = JSON.stringify(ready.data);
  [
    "auth-secret-should-not-leak",
    "google-secret-should-not-leak",
    "github-secret-should-not-leak",
    "sk_live_secret_should_not_leak",
    "whsec_should_not_leak",
    "browser-token-should-not-leak",
    "gemini-secret-should-not-leak",
    "serp-secret-should-not-leak",
    "anthropic-secret-should-not-leak",
    "psi-secret-should-not-leak",
  ].forEach((secret) => assert.equal(serialized.includes(secret), false, `${secret} must be redacted`));

  const missing = await get(systemHealth, { env: {}, url: "https://aimark.pages.dev/api/system-health" });
  assert.equal(missing.status, 200);
  assert.equal(missing.data.production.ready, false);
  assert.equal(missing.data.production.core_live_ready, false);
  assert.ok(missing.data.production.lanes.find((x) => x.id === "repo_apply").missing_items.includes("github_oauth_or_github_app_manifest"));
  assert.ok(missing.data.production.missing_required_groups.includes("storage"));
  assert.ok(missing.data.production.missing_required_groups.includes("auth"));
  assert.ok(missing.data.groups.find((g) => g.id === "auth").status === "missing");
}

async function testScanProvisionalWhenPageSpeedUnavailable() {
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.includes("pagespeedonline")) {
      return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/robots.txt")) return response("User-agent: *\nAllow: /\nSitemap: https://abcclinic.test/sitemap.xml");
    if (url.endsWith("/sitemap.xml")) return response("<urlset><url><loc>https://abcclinic.test/</loc></url></urlset>");
    if (url.endsWith("/llms.txt")) return response("# ABC Dental Clinic\nDental services, quote, contact, FAQ, Bangkok.");
    return response(htmlPage());
  }, async () => {
    const { status, data } = await post(scanSite, {
      url: "https://abcclinic.test/",
      lang: "th",
      deterministic_only: true,
    }, { url: "https://aimark.pages.dev/api/scan" });
    assert.equal(status, 200);
    assert.equal(data._score_status, "provisional");
    assert.equal(data._performance_verified, false);
    assert.equal(data._performance_lite.available, true);
    assert.equal(data._performance_lite.verified_core_web_vitals, false);
    assert.ok(data._performance_lite.html_fetch_ms >= 0);
    assert.ok(data._performance_lite.html_kb > 0);
    assert.match(data._performance_lite.note, /not Lighthouse or Core Web Vitals/i);
    assert.ok(data.overall < 100, "unverified PageSpeed must prevent a perfect score");
    assert.match(data._verification.score_guardrail, /12% performance weight/i);
    assert.ok(data._verification.cannot_infer_from_public_scan.includes("traffic_source_attribution"));
  });
}

async function testScanCachesPageSpeedResultToAvoidQuotaBurn() {
  const kv = memoryKv();
  let psiCalls = 0;
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.includes("pagespeedonline")) {
      psiCalls += 1;
      return new Response(JSON.stringify({
        lighthouseResult: {
          categories: { performance: { score: 0.92 } },
          audits: {
            "largest-contentful-paint": { numericValue: 1800 },
            "interaction-to-next-paint": { numericValue: 120 },
            "cumulative-layout-shift": { numericValue: 0.03 },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/robots.txt")) return response("User-agent: *\nAllow: /\nSitemap: https://abcclinic.test/sitemap.xml");
    if (url.endsWith("/sitemap.xml")) return response("<urlset><url><loc>https://abcclinic.test/</loc></url></urlset>");
    if (url.endsWith("/llms.txt")) return response("# ABC Dental Clinic\nDental services, quote, contact, FAQ, Bangkok.");
    return response(htmlPage());
  }, async () => {
    const env = { PROOF_KV: kv, GOOGLE_PSI_KEY: "psi-test-key" };
    const first = await post(scanSite, {
      url: "https://abcclinic.test/",
      lang: "th",
      deterministic_only: true,
    }, { env, url: "https://aimark.pages.dev/api/scan" });
    const second = await post(scanSite, {
      url: "https://abcclinic.test/",
      lang: "th",
      deterministic_only: true,
    }, { env, url: "https://aimark.pages.dev/api/scan" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(psiCalls, 1, "repeat scan of the same URL must use cached PSI instead of burning quota");
    assert.equal(first.data._performance_verified, true);
    assert.equal(second.data._performance_verified, true);
    assert.equal(first.data._cwv.cache_status, "miss");
    assert.equal(second.data._cwv.cache_status, "hit");
    assert.equal(second.data._performance, 92);
  });
}

async function testLeadScoutRejectsContentPlatformsAndNormalizesBusinessArticles() {
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.includes("serpapi.com")) {
      return new Response(JSON.stringify({
        organic_results: [
          {
            title: "Reddit sitemap thread",
            link: "https://www.reddit.com/r/Wordpress/comments/wrhhf3/how_do_i_completely_nuke_my_old_sitemap/",
            snippet: "Forum discussion about sitemap.",
          },
          {
            title: "ABC Clinic blog sitemap",
            link: "https://abcclinic.test/blog/sitemap-guide",
            snippet: "คลินิก dental กรุงเทพ ติดต่อ ราคา",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/robots.txt")) return response("User-agent: *\nAllow: /");
    if (url.endsWith("/sitemap.xml")) return response("<urlset><url><loc>https://abcclinic.test/</loc></url></urlset>");
    if (url.endsWith("/llms.txt")) return response("", 404);
    return response(htmlPage());
  }, async () => {
    const { status, data } = await post(leadScout, {
      query: "คลินิก dental กรุงเทพ ติดต่อ ราคา",
      lang: "th",
      max_results: 5,
    }, {
      env: { SERPAPI_KEY: "serp-test" },
      url: "https://aimark.pages.dev/api/lead-scout",
    });
    assert.equal(status, 200);
    assert.equal(data.error, undefined);
    assert.equal(data.leads.length, 1);
    assert.equal(data.leads[0].host, "abcclinic.test");
    assert.equal(data.leads[0].url, "https://abcclinic.test/");
    assert.equal(data.leads[0].normalized_from_content, true);
    assert.equal(/reddit/i.test(JSON.stringify(data.leads)), false);
    assert.ok(data.leads[0].qualification.score >= 2);
    assert.equal(data.outreach_batch.daily_limit, 20);
    assert.equal(data.outreach_batch.mode, "one_to_one_free_scan_outreach");
    assert.equal(data.outreach_batch.send_order.length, 1);
    assert.match(data.outreach_batch.guardrail_summary, /outbound|assistant|หลักฐาน/i);
    assert.equal(data.leads[0].outreach_pack.evidence_scope, "public_scan_only");
    assert.equal(data.leads[0].outreach_pack.free_scan_offer.required, true);
    assert.match(data.leads[0].outreach_pack.dm.message, /รูปสแกนฟรี|free/i);
    assert.ok(data.leads[0].outreach_pack.proof_snapshot.cannot_claim_without_access.includes("actual_ad_spend"));
  });
}

async function testLeadScoutDoesNotTurnInformationalSearchIntoLeads() {
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.includes("serpapi.com")) {
      return new Response(JSON.stringify({
        organic_results: [
          {
            title: "Reddit sitemap thread",
            link: "https://www.reddit.com/r/Wordpress/comments/wrhhf3/how_do_i_completely_nuke_my_old_sitemap/",
            snippet: "Forum discussion about sitemap.",
          },
          {
            title: "Sitemap XML and robots.txt guide",
            link: "https://sennalabs.com/blog/sitemap-xml-and-robots-txt-how-to-help-google-understand-your-website",
            snippet: "A blog guide explaining sitemap and robots.txt for websites.",
          },
          {
            title: "XML Sitemap คืออะไร",
            link: "https://www.makewebeasy.com/th/blog/xml-sitemap/",
            snippet: "บทความความรู้เรื่อง sitemap สำหรับ WordPress และ SEO",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/robots.txt")) return response("User-agent: *\nAllow: /");
    if (url.endsWith("/sitemap.xml")) return response("<urlset><url><loc>https://sennalabs.com/</loc></url></urlset>");
    if (url.endsWith("/llms.txt")) return response("", 404);
    return response(htmlPage({ title: "Agency Services Contact Quote Bangkok", words: 620 }));
  }, async () => {
    const { status, data } = await post(leadScout, {
      query: "sitemap xml robots wordpress",
      lang: "en",
      max_results: 5,
    }, {
      env: { SERPAPI_KEY: "serp-test" },
      url: "https://aimark.pages.dev/api/lead-scout",
    });
    assert.equal(status, 200);
    assert.equal(data.leads, undefined, "informational queries must not return outreach leads");
    assert.equal(data.outreach_batch, undefined, "informational queries must not create DM batches");
    assert.match(data.error, /No qualified SME leads/i);
    assert.equal(data.search_intent.mode, "educational_or_content");
    assert.ok(data.rejected_count >= 1);
    assert.ok(data.rejected_examples.some((x) => x.reason === "query_not_commercial_enough_for_outreach"));
    assert.match(data.next_query_hint, /industry.*location.*contact/i);
  });
}

function proofScan({ overall, grade, techScore, aiScore, metaStatus, schemaStatus, faqStatus }) {
  const failOrPass = (status, check, detail, fix) => ({
    status,
    severity: status === "pass" ? "low" : "high",
    check,
    detail,
    fix,
  });
  return {
    url: "https://proofclinic.test/",
    overall,
    grade,
    summary: "Synthetic proof clinic scan.",
    _score_status: "verified",
    _performance_verified: true,
    _performance: 91,
    _facts: {
      fetch: {
        home: { ok: true, status: 200 },
        robots: { present: true },
        sitemap: { present: true },
        llms: { present: true },
      },
    },
    categories: [
      {
        name: "Technical SEO (Google 2026)",
        score: techScore,
        findings: [
          failOrPass(metaStatus, "Meta description", metaStatus === "pass" ? "Present and concise" : "Missing", "Add a buyer-focused meta description."),
          failOrPass(schemaStatus, "Structured data (JSON-LD)", schemaStatus === "pass" ? "LocalBusiness schema found" : "Missing", "Add LocalBusiness JSON-LD."),
        ],
      },
      {
        name: "AI Search / GEO-AEO",
        score: aiScore,
        findings: [
          failOrPass(faqStatus, "FAQ / question-style content", faqStatus === "pass" ? "Visible FAQ found" : "No buyer FAQ", "Add visible answer-led FAQ content."),
        ],
      },
    ],
  };
}

async function testProofBeforeAfterPersistsShareableEvidence() {
  const kv = memoryKv();
  let scanCalls = 0;
  await withMockFetch(async (input, init = {}) => {
    const url = String(input?.url || input || "");
    if (url.endsWith("/api/scan")) {
      scanCalls += 1;
      return new Response(JSON.stringify(scanCalls === 1
        ? proofScan({ overall: 52, grade: "D", techScore: 50, aiScore: 44, metaStatus: "fail", schemaStatus: "fail", faqStatus: "fail" })
        : proofScan({ overall: 86, grade: "A", techScore: 91, aiScore: 84, metaStatus: "pass", schemaStatus: "pass", faqStatus: "pass" })
      ), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/citation-probe")) {
      const body = JSON.parse(String(init.body || "{}"));
      return new Response(JSON.stringify({
        live: true,
        status: "completed",
        preview: false,
        observed_share_of_answer: "1/1",
        engines_used: ["gemini"],
        results: [{
          query: (body.buyer_queries || [])[0] || "proof clinic Bangkok",
          engine: "gemini",
          cited: true,
          competitors_named: ["competitor.test"],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const env = { PROOF_KV: kv, SITE_ORIGIN: "https://aimark.pages.dev" };
    const first = await post(proofPost, {
      url: "https://proofclinic.test/",
      account: "owner@example.com",
      lang: "th",
      include_citation_probe: true,
      buyer_queries: ["คลินิก proof ที่ไหนดี"],
    }, { env, url: "https://aimark.pages.dev/api/proof" });
    assert.equal(first.status, 200);
    assert.equal(first.data.persisted, true);
    assert.equal(first.data.first_run, true);
    assert.equal(first.data.report.status, "baseline_saved");
    assert.equal(first.data.report.scoreline.after, 52);
    assert.equal(first.data.report.mission_coverage.before_after_score, true);
    assert.equal(first.data.report.mission_coverage.ai_citation_probe, true);
    assert.match(first.data.proof_url, /\/api\/proof\?share=/);

    const second = await post(proofPost, {
      url: "https://proofclinic.test/",
      account: "owner@example.com",
      lang: "th",
      include_citation_probe: true,
      buyer_queries: ["คลินิก proof ที่ไหนดี"],
    }, { env, url: "https://aimark.pages.dev/api/proof" });
    assert.equal(second.status, 200);
    assert.equal(second.data.persisted, true);
    assert.equal(second.data.first_run, false);
    assert.equal(second.data.deltas.overall_before, 52);
    assert.equal(second.data.deltas.overall_after, 86);
    assert.equal(second.data.deltas.overall_delta, 34);
    assert.equal(second.data.report.status, "improved");
    assert.equal(second.data.report.scoreline.before, 52);
    assert.equal(second.data.report.scoreline.after, 86);
    assert.equal(second.data.report.scoreline.delta, 34);
    assert.ok(second.data.report.wins.some((win) => /Meta description|Structured data|FAQ/i.test(win.text)));
    assert.equal(second.data.report.citation_probe.status, "completed");
    assert.equal(second.data.report.screenshots.status, "setup_required");
    assert.equal(second.data.screenshots.latest.diagnostic.cf_account_id_present, false);
    assert.equal(second.data.screenshots.latest.diagnostic.token_present, false);
    assert.equal(second.data.history.length, 2);
    assert.equal(scanCalls, 2);

    const share = new URL(second.data.proof_url).searchParams.get("share");
    const shared = await get(proofGet, {
      env,
      url: `https://aimark.pages.dev/api/proof?share=${encodeURIComponent(share)}`,
    });
    assert.equal(shared.status, 200);
    assert.equal(shared.data.public, true);
    assert.equal(shared.data.report.status, "improved");
    assert.equal(shared.data.deltas.overall_delta, 34);
    assert.equal(shared.data.latest.overall, 86);
    assert.equal(shared.data.baseline.overall, 52);
  });
}

async function testBotIntelligenceLoopSummarizesEvidenceAndAgentActions() {
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.endsWith("/api/bot-access")) {
      return new Response(JSON.stringify({
        summary: { can_read: 7, total: 8, headline: "7/8 major AI/search crawlers can actually read this page." },
        bots: [{ bot: "GPTBot", verdict: "can_read" }, { bot: "ClaudeBot", verdict: "cannot_read" }],
        js_render_risk: { likely: true, note: "JS-render risk" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/citation-probe")) {
      return new Response(JSON.stringify({
        live: true,
        observed_share_of_answer: "0/1",
        engines_used: ["google"],
        results: [{ query: "best clinic", engine: "google", cited: false }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/render-check")) {
      return new Response(JSON.stringify({
        live: true,
        hidden_from_ai_pct: 55,
        headline: "~55% of your content is invisible to JS-less AI bots",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const { status, data } = await post(botIntel, {
      url: "https://abcclinic.test/",
      lang: "th",
    }, { url: "https://aimark.pages.dev/api/bot-intel" });
    assert.equal(status, 200);
    assert.equal(data.status, "observed");
    assert.equal(data.intelligence_loop.stages.length, 5);
    assert.match(data.intelligence_loop.differentiator, /AI Mark/);
    assert.ok(data.summary.blockers.length >= 2);
    assert.ok(data.next_actions.some((x) => /server-render|pre-render|server-rendered/i.test(`${x.action} ${x.agent_task}`)));
    assert.equal(data.agent_handoff.kind, "ai_bot_intelligence_loop");
  });
}

async function testCheckoutStatusReconcilesPaidStripeSessionOnce() {
  const kv = memoryKv();
  let stripeFetches = 0;
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.includes("api.stripe.com/v1/checkout/sessions/cs_paid_500")) {
      stripeFetches += 1;
      return new Response(JSON.stringify({
        id: "cs_paid_500",
        mode: "payment",
        payment_status: "paid",
        amount_total: 19900,
        currency: "thb",
        customer_details: { email: "buyer@example.com" },
        metadata: { kind: "credits", product: "credits_5", credits: "500" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENTS_KV: kv };
    const first = await get(checkoutGet, {
      env,
      url: "https://aimark.pages.dev/api/checkout?action=status&session_id=cs_paid_500",
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.status, "recorded");
    assert.equal(first.data.payment_confirmed, true);
    assert.equal(first.data.credited, true);
    assert.equal(first.data.reconciled_from_stripe, true);
    assert.equal(first.data.credits, 500);
    assert.equal(first.data.amount_total, 19900);
    assert.equal(first.data.currency, "thb");

    const balance = await kv.get("credits:email:buyer@example.com", "json");
    assert.equal(balance.balance, 500);
    assert.equal(balance.lifetime_purchased, 500);

    const second = await get(checkoutGet, {
      env,
      url: "https://aimark.pages.dev/api/checkout?action=status&session_id=cs_paid_500",
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.status, "recorded");
    assert.equal(second.data.credited, true);
    assert.equal(second.data.credits, 500);
    assert.equal(stripeFetches, 1, "recorded checkout should not call Stripe again");
    const balanceAgain = await kv.get("credits:email:buyer@example.com", "json");
    assert.equal(balanceAgain.balance, 500, "same session must not add credits twice");
  });
}

async function testCheckoutCreatesPromptPaySessionWithSessionId() {
  let stripeBody = "";
  await withMockFetch(async (input, init = {}) => {
    const url = String(input?.url || input || "");
    if (url === "https://api.stripe.com/v1/checkout/sessions") {
      stripeBody = String(init.body || "");
      return new Response(JSON.stringify({
        id: "cs_promptpay_500",
        url: "https://checkout.stripe.com/cs_promptpay_500",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const { status, data } = await post(checkoutPost, {
      product: "credits_5",
      method: "promptpay",
      email: "buyer@example.com",
    }, {
      env: {
        STRIPE_SECRET_KEY: "sk_test",
        PAID_EXPORT_SECRET: "paid-secret",
        CHECKOUT_CURRENCY: "thb",
      },
      url: "https://aimark.pages.dev/api/checkout",
    });
    assert.equal(status, 200);
    assert.equal(data.provider, "stripe");
    assert.equal(data.session_id, "cs_promptpay_500");
    assert.equal(data.credits, 500);
    assert.equal(data.amount, 19900);
    assert.equal(data.currency, "THB");
    assert.equal(data.checkout_url, "https://checkout.stripe.com/cs_promptpay_500");
    assert.match(stripeBody, /payment_method_types%5B0%5D=promptpay/);
    assert.match(stripeBody, /metadata%5Bcredits%5D=500/);
    assert.match(stripeBody, /price_data%5D%5Bunit_amount%5D=19900/);
  });
}

async function testBotIntelligenceLoopPersistsEvidenceMemory() {
  const kv = memoryKv();
  let scenario = {
    canRead: 7,
    total: 8,
    hidden: 55,
    citation: "0/2",
    jsRisk: true,
  };
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.endsWith("/api/bot-access")) {
      return new Response(JSON.stringify({
        summary: { can_read: scenario.canRead, total: scenario.total, headline: `${scenario.canRead}/${scenario.total} major AI/search crawlers can actually read this page.` },
        bots: [{ bot: "GPTBot", verdict: "can_read" }, { bot: "ClaudeBot", verdict: scenario.canRead === 8 ? "can_read" : "cannot_read" }],
        js_render_risk: { likely: scenario.jsRisk, text_chars: scenario.jsRisk ? 420 : 1400, note: "JS-render risk" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/citation-probe")) {
      return new Response(JSON.stringify({
        live: true,
        observed_share_of_answer: scenario.citation,
        results: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/render-check")) {
      return new Response(JSON.stringify({
        live: true,
        hidden_from_ai_pct: scenario.hidden,
        headline: `~${scenario.hidden}% hidden from AI bots`,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const env = { PROOF_KV: kv };
    const first = await post(botIntel, {
      url: "https://abcclinic.test/",
      account: "geo@example.com",
      lang: "th",
    }, { env, url: "https://aimark.pages.dev/api/bot-intel" });
    assert.equal(first.status, 200);
    assert.equal(first.data.evidence_memory.persisted, true);
    assert.equal(first.data.evidence_memory.first_observation, true);
    assert.equal(first.data.learning_loop.trend, "baseline_saved");

    scenario = { canRead: 8, total: 8, hidden: 10, citation: "1/2", jsRisk: false };
    const second = await post(botIntel, {
      url: "https://abcclinic.test/",
      account: "geo@example.com",
      lang: "th",
    }, { env, url: "https://aimark.pages.dev/api/bot-intel" });
    assert.equal(second.status, 200);
    assert.equal(second.data.evidence_memory.persisted, true);
    assert.equal(second.data.evidence_memory.first_observation, false);
    assert.equal(second.data.evidence_memory.observations, 2);
    assert.equal(second.data.learning_loop.trend, "improving");
    assert.equal(second.data.learning_loop.deltas.bot_can_read_delta, 1);
    assert.equal(second.data.learning_loop.deltas.hidden_from_ai_pct_delta, -45);
    assert.equal(second.data.learning_loop.deltas.citation_pct_delta, 50);

    for (let i = 0; i < 21; i += 1) {
      await post(botIntel, {
        url: "https://abcclinic.test/",
        account: "geo@example.com",
        lang: "th",
      }, { env, url: "https://aimark.pages.dev/api/bot-intel" });
    }

    const historyReq = new Request("https://aimark.pages.dev/api/bot-intel?url=https%3A%2F%2Fabcclinic.test%2F&account=geo%40example.com");
    const historyRes = await botIntelHistory({ request: historyReq, env });
    const history = await historyRes.json();
    assert.equal(historyRes.status, 200);
    assert.equal(history.exists, true);
    assert.equal(history.history.length, 20);
    assert.equal(history.latest.bot_can_read, 8);
  });
}

function testAgentJobProgressMetadata() {
  const p = jobProgress({
    job_id: "job_test",
    status: "running",
    created_at: "2026-06-02T00:00:00.000Z",
    updated_at: new Date().toISOString(),
    delivered_at: "2026-06-02T00:01:00.000Z",
    running_at: "2026-06-02T00:02:00.000Z",
    stage: "local_runner_started",
    progress_message: "Codex started",
    progress_events: [{ at: "2026-06-02T00:02:00.000Z", status: "running", stage: "local_runner_started", message: "Codex started" }],
  }, "job_test");
  assert.equal(p.status, "running");
  assert.equal(p.next_action, "wait_for_agent_work");
  assert.equal(p.stage, "local_runner_started");
  assert.equal(p.progress_events.length, 1);
  assert.equal(p.timeline.length, 4);
  assert.equal(p.can_retry, false);

  const staleQueued = jobProgress({
    job_id: "job_stale",
    status: "queued",
    created_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  }, "job_stale");
  assert.equal(staleQueued.stale, true);
  assert.equal(staleQueued.next_action, "check_bridge_runner");
  assert.match(staleQueued.owner_message, /restart|self-test|bridge/i);

  const staleRunning = jobProgress({
    job_id: "job_stale_running",
    status: "running",
    created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  }, "job_stale_running");
  assert.equal(staleRunning.stale, true);
  assert.equal(staleRunning.next_action, "check_local_runner");
  assert.match(staleRunning.owner_message, /local runner|restart|retry/i);
}

async function testAgentPollClaimsJobAndMarksDelivered() {
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "agent-test-secret", AGENT_KV: kv };
  const agent = {
    agent_id: "agent_test",
    sid: "sid_test",
    email: "owner@example.com",
    device_name: "Test bridge",
  };
  const token = await signAgentToken(agent, env, 3600);
  const job = {
    id: "job_claim_test",
    status: "queued",
    created_at: "2026-06-02T00:00:00.000Z",
    updated_at: "2026-06-02T00:00:00.000Z",
    payload: { kind: "ai_bot_intelligence_loop", client_url: "https://abcclinic.test/" },
  };
  await kv.put(agentQueueKey(agent.agent_id), JSON.stringify([job]));
  await kv.put(`agent_job_user:${agent.sid}:${job.id}`, JSON.stringify({
    job_id: job.id,
    status: "queued",
    created_at: job.created_at,
    updated_at: job.updated_at,
    payload: job.payload,
  }));

  const request = new Request("https://aimark.pages.dev/api/agent/jobs/poll", {
    headers: { authorization: `Bearer ${token}` },
  });
  const response = await pollAgentJob({ request, env });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, "job_available");
  assert.equal(data.claimed, true);
  assert.equal(data.queue_depth, 0);
  assert.equal(data.job.id, job.id);
  assert.equal(data.job.status, "delivered_to_bridge");

  const stored = await kv.get(`agent_job_user:${agent.sid}:${job.id}`, "json");
  assert.equal(stored.status, "delivered_to_bridge");
  assert.ok(stored.delivered_at);
  assert.deepEqual(await kv.get(agentQueueKey(agent.agent_id), "json"), []);

  const second = await pollAgentJob({ request, env });
  const secondData = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondData.status, "idle");
  assert.equal(secondData.job, null);
}

async function testAgentDevicePairingJobResultEndToEnd() {
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "owner-session-secret", AGENT_KV: kv };
  const { token: sessionToken, session } = await signSession({
    sid: "sid_owner_flow",
    provider: "google",
    email: "owner@example.com",
    name: "Owner",
  }, env.AUTH_SESSION_SECRET);
  const cookie = `aimark_session=${sessionToken}`;

  const start = await post(startAgentPair, {
    device_name: "Customer laptop bridge",
  }, { env, url: "https://aimark.pages.dev/api/agent/pair/device/start" });
  assert.equal(start.status, 200);
  assert.equal(start.data.status, "pending");
  assert.ok(start.data.device_code);
  assert.ok(start.data.user_code);
  assert.match(start.data.verification_uri_complete, /agent-pair\.html/);

  const pendingToken = await post(claimAgentPairToken, {
    device_code: start.data.device_code,
  }, { env, url: "https://aimark.pages.dev/api/agent/pair/token" });
  assert.equal(pendingToken.status, 428);
  assert.equal(pendingToken.data.error, "authorization_pending");

  const approve = await post(approveAgentPair, {
    user_code: start.data.user_code,
  }, {
    env,
    headers: { cookie },
    url: "https://aimark.pages.dev/api/agent/pair/approve",
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.status, "approved");
  assert.equal(approve.data.agent.mode, "cloud");

  const tokenClaim = await post(claimAgentPairToken, {
    device_code: start.data.device_code,
  }, { env, url: "https://aimark.pages.dev/api/agent/pair/token" });
  assert.equal(tokenClaim.status, 200);
  assert.equal(tokenClaim.data.status, "paired");
  assert.ok(tokenClaim.data.agent_token);
  assert.equal(tokenClaim.data.agent.device_name, "Customer laptop bridge");

  const bearer = `Bearer ${tokenClaim.data.agent_token}`;
  const heartbeat = await post(agentHeartbeat, {}, {
    env,
    headers: { authorization: bearer },
    url: "https://aimark.pages.dev/api/agent/heartbeat",
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.data.status, "ok");
  assert.equal(heartbeat.data.agent.agent_id, tokenClaim.data.agent.agent_id);

  const enqueue = await post(enqueueAgentJob, {
    kind: "ai_bot_intelligence_loop",
    client_url: "https://abcclinic.test/",
    hermes_task: { goal: "Run proof loop and return evidence." },
  }, {
    env,
    headers: { cookie },
    url: "https://aimark.pages.dev/api/agent/jobs",
  });
  assert.equal(enqueue.status, 200);
  assert.equal(enqueue.data.status, "queued_for_agent");
  assert.ok(enqueue.data.job_id);
  assert.equal(enqueue.data.connected, true);
  assert.equal(enqueue.data.progress.status, "queued");
  assert.equal(enqueue.data.progress.next_action, "wait_for_bridge_poll");

  const duplicate = await post(enqueueAgentJob, {
    kind: "ai_bot_intelligence_loop",
    client_url: "https://abcclinic.test/",
    hermes_task: { goal: "Run proof loop and return evidence." },
  }, {
    env,
    headers: { cookie },
    url: "https://aimark.pages.dev/api/agent/jobs",
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.deduped, true);
  assert.equal(duplicate.data.job_id, enqueue.data.job_id);
  assert.equal(duplicate.data.progress.next_action, "wait_for_bridge_poll");

  const poll = await get(pollAgentJob, {
    env,
    headers: { authorization: bearer },
    url: "https://aimark.pages.dev/api/agent/jobs/poll",
  });
  assert.equal(poll.status, 200);
  assert.equal(poll.data.status, "job_available");
  assert.equal(poll.data.claimed, true);
  assert.equal(poll.data.job.id, enqueue.data.job_id);
  assert.equal(poll.data.job.status, "delivered_to_bridge");

  const delivered = await get(getAgentJobStatus, {
    env,
    headers: { cookie },
    url: `https://aimark.pages.dev/api/agent/jobs/status?job_id=${encodeURIComponent(enqueue.data.job_id)}`,
  });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.data.status, "delivered_to_bridge");
  assert.equal(delivered.data.progress.next_action, "wait_for_local_runner_result");

  const runningProgress = await post(postAgentJobProgress, {
    job_id: enqueue.data.job_id,
    status: "running",
    stage: "local_runner_started",
    action: "browser_check",
    target_url: "https://abcclinic.test/services",
    message: "Codex / GPT test runner started on local bridge.",
    screenshot_url: "https://aimark.pages.dev/proof/mock.png",
    proof_links: ["https://aimark.pages.dev/proof/mock"],
    files: [{ path: "content/services.html", status: "drafted" }],
    runner: { provider: "codex", command: "codex", model: "test", mode: "full-access", label: "Codex / GPT · test" },
  }, {
    env,
    headers: { authorization: bearer },
    url: "https://aimark.pages.dev/api/agent/jobs/progress",
  });
  assert.equal(runningProgress.status, 200);
  assert.equal(runningProgress.data.status, "progress_recorded");
  assert.equal(runningProgress.data.job_status, "running");

  const runningStatus = await get(getAgentJobStatus, {
    env,
    headers: { cookie },
    url: `https://aimark.pages.dev/api/agent/jobs/status?job_id=${encodeURIComponent(enqueue.data.job_id)}`,
  });
  assert.equal(runningStatus.status, 200);
  assert.equal(runningStatus.data.status, "running");
  assert.equal(runningStatus.data.progress.next_action, "wait_for_agent_work");
  assert.equal(runningStatus.data.progress.stage, "local_runner_started");
  assert.equal(runningStatus.data.progress.progress_events.length, 1);
  assert.equal(runningStatus.data.progress.progress_events[0].action, "browser_check");
  assert.equal(runningStatus.data.progress.progress_events[0].target_url, "https://abcclinic.test/services");
  assert.equal(runningStatus.data.progress.progress_events[0].screenshot_url, "https://aimark.pages.dev/proof/mock.png");
  assert.equal(runningStatus.data.progress.progress_events[0].proof_links[0], "https://aimark.pages.dev/proof/mock");
  assert.equal(runningStatus.data.progress.progress_events[0].files[0].path, "content/services.html");

  const duplicateWhileRunning = await post(enqueueAgentJob, {
    kind: "ai_bot_intelligence_loop",
    client_url: "https://abcclinic.test/",
    hermes_task: { goal: "Run proof loop and return evidence." },
  }, {
    env,
    headers: { cookie },
    url: "https://aimark.pages.dev/api/agent/jobs",
  });
  assert.equal(duplicateWhileRunning.status, 200);
  assert.equal(duplicateWhileRunning.data.deduped, true);
  assert.equal(duplicateWhileRunning.data.job_id, enqueue.data.job_id);
  assert.equal(duplicateWhileRunning.data.progress.next_action, "wait_for_agent_work");

  const result = await post(postAgentJobResult, {
    job_id: enqueue.data.job_id,
    status: "completed",
    summary: "ตรวจแล้วและส่ง proof กลับเรียบร้อย",
    markdown: "## Result\n- Evidence captured\n- Next step ready",
    result: { runner_label: "Codex / GPT · test" },
    proof_links: ["https://aimark.pages.dev/api/proof?share=test"],
  }, {
    env,
    headers: { authorization: bearer },
    url: "https://aimark.pages.dev/api/agent/jobs/result",
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.status, "result_recorded");
  assert.equal(result.data.visible_to_user, true);

  const completed = await get(getAgentJobStatus, {
    env,
    headers: { cookie },
    url: `https://aimark.pages.dev/api/agent/jobs/status?job_id=${encodeURIComponent(enqueue.data.job_id)}`,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.status, "completed");
  assert.equal(completed.data.progress.next_action, "read_result");
  assert.equal(completed.data.job.summary, "ตรวจแล้วและส่ง proof กลับเรียบร้อย");
  assert.equal(completed.data.job.result.runner_label, "Codex / GPT · test");
  assert.equal(session.sid, "sid_owner_flow");
}

await testLineOaPreview();
await testLineOaPaidFullKit();
await testCreditBalanceUnlocksPaidFeaturesWithoutPaidCookie();
await testRenderCheckDebitsCreditsAndRejectsInsufficientBalance();
await testExportPackageAndDeployDebitCreditsIdempotently();
await testSystemHealthReportsReadinessWithoutLeakingSecrets();
await testScanProvisionalWhenPageSpeedUnavailable();
await testScanCachesPageSpeedResultToAvoidQuotaBurn();
await testLeadScoutRejectsContentPlatformsAndNormalizesBusinessArticles();
await testLeadScoutDoesNotTurnInformationalSearchIntoLeads();
await testProofBeforeAfterPersistsShareableEvidence();
await testCheckoutStatusReconcilesPaidStripeSessionOnce();
await testCheckoutCreatesPromptPaySessionWithSessionId();
await testBotIntelligenceLoopSummarizesEvidenceAndAgentActions();
await testBotIntelligenceLoopPersistsEvidenceMemory();
testAgentJobProgressMetadata();
await testAgentPollClaimsJobAndMarksDelivered();
await testAgentDevicePairingJobResultEndToEnd();
await testSkillRegistryIsSingleSourceOfTruth();

async function testConversionAuditSkillIsPricedAndPreviews() {
  // Pricing is single-sourced from the skill registry (no separate table edit).
  assert.equal(creditCost("conversion_audit"), 50, "conversion_audit must be priced via the skill registry");
  assert.ok(getSkill("ad_audit"), "alias 'ad_audit' must resolve to the conversion_audit skill");

  // Deterministic analyzer: a strong landing page scores high...
  const strong = analyzeConversion(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<script>gtag('config','G-XXXX')</script></head><body>` +
    `<h1>โรงหล่อเหล็ก รับงานชิ้นเดียว ไม่มีขั้นต่ำ</h1>` +
    `<p>บริษัทของเรารับผลิตชิ้นส่วนหล่อโลหะตามแบบ ด้วยประสบการณ์ 25 ปี ได้รับการรับรองมาตรฐาน ISO 9001 ` +
    `มีรีวิวลูกค้าจริงและผลงานจำนวนมาก รับประกันคุณภาพทุกชิ้นงาน ส่งมอบตรงเวลา ราคายุติธรรม ` +
    `รองรับงานตั้งแต่ชิ้นเดียวจนถึงล็อตใหญ่ ทีมงานวิศวกรพร้อมให้คำปรึกษาตลอดกระบวนการผลิตและตรวจสอบคุณภาพ</p>` +
    `<a href="tel:0986362356">โทร</a> <a href="https://line.me/R/ti/p/@scnw">เพิ่มเพื่อน LINE</a>` +
    `<a href="#quote"><button>ขอใบเสนอราคา</button></a>` +
    `<form><input name="name"><input type="hidden" name="src"></form></body></html>`,
    "https://good.example", "th",
  );
  assert.ok(strong.conversion_score >= 70, `strong page should score >=70, got ${strong.conversion_score}`);
  assert.equal(strong.tracking_detected, true);
  assert.equal(strong.channels.line, true);

  // ...and a bare page scores low and names the real leaks.
  const weak = analyzeConversion(`<!doctype html><html><head><title>x</title></head><body><div>welcome</div></body></html>`, "https://bad.example", "en");
  assert.ok(weak.conversion_score <= 40, `bare page should score <=40, got ${weak.conversion_score}`);
  assert.equal(weak.tracking_detected, false);
  const weakLeaks = weak.leaks.map((l) => l.id);
  assert.ok(weakLeaks.includes("conversion_tracking"), "bare page must flag missing tracking");
  assert.ok(weakLeaks.includes("cta"), "bare page must flag missing CTA");

  // Endpoint free preview: score + honest upsell at the registry price, no secret leak.
  const { status, data } = await post(conversionAudit, { html: "<html><body><div>nothing here</div></body></html>", lang: "en" });
  assert.equal(status, 200);
  assert.equal(data.paid, false);
  assert.equal(data.status, "preview");
  assert.equal(data.upgrade.required, true);
  assert.equal(data.upgrade.credits_required, 50);
  assert.equal(typeof data.conversion_score, "number");
  assert.equal(/api[_-]?key|secret|bearer\s/i.test(JSON.stringify(data)), false, "preview must not leak secret-like fields");
}
await testConversionAuditSkillIsPricedAndPreviews();

async function testLocalSeoSkillIsPricedAndPreviews() {
  // Pricing single-sourced from the skill registry.
  assert.equal(creditCost("local_seo_audit"), 75, "local_seo_audit must be priced via the skill registry");
  assert.ok(getSkill("gbp"), "alias 'gbp' must resolve to the local_seo_audit skill");

  // Deterministic analyzer: a complete local page scores high...
  const strong = analyzeLocalSeo(
    `<!doctype html><html><head><script type="application/ld+json">` +
    `{"@context":"https://schema.org","@type":"LocalBusiness","name":"Success Casting",` +
    `"telephone":"+66-2-800-1234","address":{"@type":"PostalAddress","streetAddress":"123 ถนนสุขุมวิท","addressLocality":"กรุงเทพ","postalCode":"10110"},` +
    `"geo":{"@type":"GeoCoordinates","latitude":13.7,"longitude":100.5},` +
    `"openingHours":"Mo-Fr 08:00-17:00","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"52"},` +
    `"sameAs":["https://g.page/successcasting"]}</script></head><body>` +
    `<address>123 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพ 10110</address>` +
    `<a href="tel:028001234">โทร</a> เวลาทำการ จันทร์-ศุกร์ พื้นที่ให้บริการทั่วประเทศ ` +
    `<a href="https://maps.google.com/?q=successcasting">แผนที่</a> รีวิวลูกค้า 4.8 ดาว</body></html>`,
    "https://good.example", "th",
  );
  assert.ok(strong.local_score >= 80, `complete local page should score >=80, got ${strong.local_score}`);
  assert.equal(strong.signals.localbusiness_schema, true);
  assert.equal(strong.signals.reviews, true);

  // ...and a bare page scores low and names the real gaps.
  const weak = analyzeLocalSeo(`<!doctype html><html><head><title>x</title></head><body><div>welcome</div></body></html>`, "https://bad.example", "en");
  assert.ok(weak.local_score <= 30, `bare page should score <=30, got ${weak.local_score}`);
  const weakGaps = weak.leaks.map((l) => l.id);
  assert.ok(weakGaps.includes("localbusiness_schema"), "bare page must flag missing LocalBusiness schema");
  assert.ok(weakGaps.includes("nap_phone"), "bare page must flag missing phone");

  // Endpoint free preview at the registry price, no secret leak.
  const { status, data } = await post(localSeoAudit, { html: "<html><body><div>nothing</div></body></html>", lang: "en" });
  assert.equal(status, 200);
  assert.equal(data.paid, false);
  assert.equal(data.status, "preview");
  assert.equal(data.upgrade.credits_required, 75);
  assert.equal(typeof data.local_score, "number");
  assert.equal(/api[_-]?key|secret|bearer\s/i.test(JSON.stringify(data)), false, "preview must not leak secret-like fields");
}
await testLocalSeoSkillIsPricedAndPreviews();

async function testTechAuditSkillIsPricedAndPreviews() {
  assert.equal(creditCost("tech_audit"), 50, "tech_audit must be priced via the skill registry");
  assert.ok(getSkill("security_audit"), "alias 'security_audit' must resolve to tech_audit");

  // A hardened, well-structured page scores high...
  const strongHtml =
    `<!doctype html><html lang="th"><head>` +
    `<title>Success Casting Foundry — Quality Metal Castings</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="description" content="Success Casting is a Thai metal-casting foundry making FC and FCD castings to drawing, single pieces to full lots, with quality checks and fast quotes.">` +
    `<link rel="canonical" href="https://good.example/">` +
    `<script type="application/ld+json">{"@type":"Organization","name":"Success Casting","datePublished":"2026-01-01"}</script>` +
    `</head><body><header></header><nav></nav><main><article>` +
    `<h1>Success Casting Foundry</h1><img src="a.jpg" alt="casting">` +
    `<a href="/about">about</a><a href="/contact">contact</a><a href="/privacy">privacy</a><a href="/terms">terms</a><a href="/services">services</a>` +
    `<script>gtag('config','G-X')</script>` +
    `</article><section></section></main><footer></footer></body></html>`;
  const strongHeaders = {
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
  };
  const strong = analyzeTech(strongHtml, strongHeaders, "https://good.example/", "th");
  assert.ok(strong.tech_score >= 80, `hardened page should score >=80, got ${strong.tech_score}`);
  assert.equal(strong.security.hsts, true);
  assert.equal(strong.security.clickjacking, true);

  // ...a bare page with no security headers scores low and names the gaps.
  const weak = analyzeTech(`<!doctype html><html><body><div>hi</div></body></html>`, {}, "https://bad.example", "en");
  assert.ok(weak.tech_score <= 30, `bare page should score <=30, got ${weak.tech_score}`);
  const weakGaps = weak.leaks.map((l) => l.id);
  assert.ok(weakGaps.includes("hsts"), "must flag missing HSTS");
  assert.ok(weakGaps.includes("clickjacking"), "must flag missing clickjacking protection");

  // Endpoint free preview at the registry price, no secret leak.
  const { status, data } = await post(techAudit, { html: "<html><body>x</body></html>", lang: "en" });
  assert.equal(status, 200);
  assert.equal(data.paid, false);
  assert.equal(data.status, "preview");
  assert.equal(data.upgrade.credits_required, 50);
  assert.equal(typeof data.tech_score, "number");
  assert.equal(/api[_-]?key|secret|bearer\s/i.test(JSON.stringify(data)), false, "preview must not leak secret-like fields");
}
await testTechAuditSkillIsPricedAndPreviews();

async function testAgentHubToolContractAndMcp() {
  // The tool contract is DERIVED from the skill registry: one tool per skill.
  const defs = toolDefinitions();
  assert.ok(defs.length >= 18, "every registry skill must surface as a tool");
  const exec = defs.filter((t) => t._aimark.executable).map((t) => t.name);
  const gated = defs.filter((t) => t._aimark.gated).map((t) => t.name);
  // Read-only audits are executable; deploy/write/send skills are gated.
  for (const id of ["scan", "tech_audit", "conversion_audit", "local_seo_audit", "social_visibility", "lead_scout"]) {
    assert.ok(exec.includes(id), `${id} should be an executable read-only tool`);
  }
  for (const id of ["deploy_apply", "site_improvement", "line_oa_growth_kit", "export_package"]) {
    assert.ok(gated.includes(id), `${id} must be gated behind owner approval`);
  }
  // Aliases resolve to real skill ids.
  assert.equal(resolveToolId("scan_site"), "scan");
  assert.equal(resolveToolId("security_audit"), "tech_audit");
  assert.equal(resolveToolId("totally_unknown"), "");
  // Every tool has a JSON Schema input with the right required fields.
  const scanDef = defs.find((t) => t.name === "scan");
  assert.equal(scanDef.inputSchema.type, "object");
  assert.ok(scanDef.inputSchema.required.includes("url"));

  const ctx = (body) => ({ request: new Request("https://aimark.pages.dev/api/test", { method: "POST" }), env: {}, _body: body });

  // Approval-first: a gated tool never auto-runs from an external model.
  const gatedRun = await executeTool("deploy_apply", { url: "https://x.example" }, ctx());
  assert.equal(gatedRun.ok, false);
  assert.equal(gatedRun.error, "approval_required");
  // Unknown tool is rejected; missing required arg is caught before any dispatch.
  assert.equal((await executeTool("nope", {}, ctx())).error, "unknown_tool");
  assert.equal((await executeTool("scan", {}, ctx())).error, "missing_argument");

  // MCP JSON-RPC surface: initialize, tools/list, and a gated tools/call.
  const rpc = async (msg) => (await (await mcpPost({ request: new Request("https://aimark.pages.dev/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) }), env: {} })).json());
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "aimark");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(Array.isArray(list.result.tools) && list.result.tools.length >= 18);
  const gatedCall = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "deploy_apply", arguments: { url: "https://x.example" } } });
  assert.equal(gatedCall.result.isError, true);
  assert.match(gatedCall.result.content[0].text, /approval_required/);
  const bad = await rpc({ jsonrpc: "2.0", id: 4, method: "bogus" });
  assert.equal(bad.error.code, -32601);
  // The contract must not leak secret-like fields.
  assert.equal(/api[_-]?key|secret|bearer\s|client_secret/i.test(JSON.stringify(defs)), false);
}
await testAgentHubToolContractAndMcp();

async function testSkillRegistryIsSingleSourceOfTruth() {
  // Pricing is single-sourced: _credits.creditCost() must equal the registry
  // for every charged skill, and the cost must be positive.
  const charged = ["line_oa_growth_kit", "render_check", "proof_loop", "ai_bot_intelligence_loop", "export_package", "deploy_apply"];
  for (const id of charged) {
    assert.ok(skillCreditCost(id) > 0, `${id} must have a positive registry cost`);
    assert.equal(creditCost(id), skillCreditCost(id), `credit cost for ${id} must come from the skill registry`);
  }
  // Unknown features never charge by accident.
  assert.equal(creditCost("totally_unknown_feature"), 0);
  // Least privilege is declared per skill, and lookup works by id and by alias.
  assert.ok(skillCapabilities("deploy_apply").includes("github_pr"), "deploy must declare the github_pr capability");
  assert.ok(skillCapabilities("render_check").includes("browser_snapshot"));
  assert.ok(getSkill("deploy"), "alias 'deploy' must resolve to a skill");
  assert.equal(getSkill("deploy").id, "deploy_apply");
  // LINE kit never gets browser/deploy power and only drafts (guardrail).
  assert.ok(skillCapabilities("line_oa_growth_kit").includes("line_draft"));
  assert.equal(skillCapabilities("line_oa_growth_kit").includes("cloudflare_deploy"), false);
  // Public endpoint lists skills and leaks no secret-like fields.
  const { status, data } = await get(listSkillsApi);
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.skills) && data.skills.length >= charged.length, "skills endpoint must list the registry");
  assert.equal(/api[_-]?key|secret|bearer|client_secret/i.test(JSON.stringify(data)), false, "skills endpoint must not leak secret-like fields");
}
await testSkillRegistryIsSingleSourceOfTruth();
console.log("api-smoke: ok");
