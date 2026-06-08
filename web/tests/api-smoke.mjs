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
import { onRequestGet as cockpitGet } from "../functions/api/cockpit.js";
import { onRequestPost as createSession } from "../functions/api/agent/session.js";
import { onRequestGet as readSessionMsg, onRequestPost as postSessionMsg } from "../functions/api/agent/session/[id]/message.js";
import { onRequestGet as listAgents, onRequestPost as createAgent } from "../functions/api/agents.js";
import { onRequestGet as getAgent } from "../functions/api/agents/[id].js";
import { onRequestPost as recordAgentProof } from "../functions/api/agents/[id]/proof.js";
import { computeReputation, attributeProofToAgent, blendSkills, makeChildProfile } from "../functions/api/_agents_registry.js";
import { onRequestPost as reproduceAgent } from "../functions/api/agents/[id]/reproduce.js";
import { onRequestPost as foundVillage } from "../functions/api/villages/found.js";
import { generateAgentReadinessBundle } from "../functions/api/_agent_readiness.js";
import { onRequestPost as genReadiness } from "../functions/api/agent-readiness/generate.js";
import { onRequestPost as joinVillage } from "../functions/api/villages/join.js";
import { onRequestGet as villageState } from "../functions/api/villages/[id].js";
import { onRequestPost as citizenHeartbeat } from "../functions/api/agents/[id]/heartbeat.js";
import { onRequestPost as mentorAgent } from "../functions/api/agents/[id]/mentor.js";
import { isAlive } from "../functions/api/_villages.js";
import { teachableSkills, isExpert } from "../functions/api/_mentorship.js";
import { computeStanding, decayFactor } from "../functions/api/_karma.js";
import { onRequestPost as hireAgent } from "../functions/api/agents/[id]/hire.js";
import { onRequestPost as migrateRep } from "../functions/api/agents/migrate-rep.js";
import { computeSplit, revenueShares } from "../functions/api/_economy.js";
import { onRequestGet as listSitesApi, onRequestPost as connectSite } from "../functions/api/sites.js";
import { onRequestGet as getSiteApi } from "../functions/api/sites/[id].js";
import { onRequestGet as alertsApi } from "../functions/api/alerts.js";
import { onRequestPost as monitorSite } from "../functions/api/sites/[id]/monitor.js";
import { onRequestGet as billingApi } from "../functions/api/billing.js";
import { onRequestPost as monitoringRun } from "../functions/api/monitoring/run.js";
import { onRequestGet as benchmarkApi } from "../functions/api/intelligence/benchmark.js";
import { median, percentileRank, cohortStats } from "../functions/api/_intelligence.js";
import { recordAudit } from "../functions/api/_db.js";
import { onRequestPost as stripeWebhook } from "../functions/api/checkout/webhook.js";
import { hasActivePlan, recordSubscription, cancelSubscription, subscriptionFromStripe, isPlanCheckout } from "../functions/api/_entitlements.js";

async function stripeSigHeader(secret, rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  return `t=${t},v1=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
import { SCHEMA_STATEMENTS, recordRecommendations, listRecommendationsForAudit } from "../functions/api/_db.js";
import { readFileSync } from "node:fs";

// In-process D1-compatible mock (over node:sqlite) so the relational platform
// layer is tested with real SQL, not a fake. node:sqlite needs Node >=22.5, so it
// is loaded dynamically and the runtime portion skips gracefully on older Node.
function makeD1Mock(DatabaseSync) {
  const sqlite = new DatabaseSync(":memory:");
  const wrap = (sql, args) => ({
    run() { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }; },
    first(col) { const row = sqlite.prepare(sql).get(...args); if (row == null) return null; return col !== undefined ? row[col] : row; },
    all() { return { results: sqlite.prepare(sql).all(...args), success: true }; },
  });
  return {
    prepare(sql) {
      const base = wrap(sql, []);
      return { bind: (...args) => wrap(sql, args), run: () => base.run(), first: (c) => base.first(c), all: () => base.all() };
    },
  };
}

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

async function testOwnerCockpitAggregatesRealAccountData() {
  // Unauthenticated: honest, no fabricated data.
  const anon = await get(cockpitGet, { env: { AUTH_SESSION_SECRET: "cockpit-secret", ENTITLEMENTS_KV: memoryKv() }, url: "https://aimark.pages.dev/api/cockpit" });
  assert.equal(anon.status, 200);
  assert.equal(anon.data.authenticated, false);

  // Authenticated with seeded per-account data.
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "cockpit-secret", ENTITLEMENTS_KV: kv };
  const sid = "sid_cockpit_owner";
  const { token } = await signSession({ sid, provider: "google", email: "owner@example.com", name: "Owner" }, env.AUTH_SESSION_SECRET);
  const now = new Date().toISOString();
  await kv.put(`agent_user:${sid}`, JSON.stringify({ agent_id: "ag1", device_name: "Owner PC" }));
  await kv.put(`agent_jobs_index:${sid}`, JSON.stringify([
    { job_id: "job_b", kind: "deploy_apply", title: "deploy fixes", high_impact: true, created_at: now },
    { job_id: "job_a", kind: "scan", title: "scan example.com", high_impact: false, created_at: now },
  ]));
  await kv.put(`agent_job_user:${sid}:job_a`, JSON.stringify({ status: "completed", updated_at: now }));
  await kv.put(`agent_job_user:${sid}:job_b`, JSON.stringify({ status: "running", updated_at: now }));
  await kv.put(`cockpit_leads:${sid}`, JSON.stringify({ query: "clinics bangkok", count: 3, leads: [{ host: "a.example", score: 5, headline: "weak site" }], generated_at: now }));

  const r = await get(cockpitGet, { env, headers: { cookie: `aimark_session=${token}` }, url: "https://aimark.pages.dev/api/cockpit" });
  assert.equal(r.status, 200);
  assert.equal(r.data.authenticated, true);
  assert.equal(r.data.connected, true);
  assert.equal(r.data.kpis.missions_total, 2);
  assert.equal(r.data.kpis.missions_active, 1, "only the running job is active");
  // The high-impact running job surfaces as an approval to review.
  assert.equal(r.data.approvals.items.length, 1);
  assert.equal(r.data.approvals.items[0].job_id, "job_b");
  assert.equal(r.data.approvals.items[0].reason, "high_impact_in_progress");
  // Completed scan shows as a verified mission.
  assert.ok(r.data.missions.items.some((m) => m.job_id === "job_a" && m.bucket === "verified"));
  // Leads are real; inbox/content are honestly not-connected (no fabrication).
  assert.equal(r.data.leads.count, 3);
  assert.equal(r.data.leads.items[0].host, "a.example");
  assert.equal(r.data.inbox.available, false);
  assert.equal(r.data.content.available, false);
  assert.equal(/api[_-]?key|secret|bearer|client_secret/i.test(JSON.stringify(r.data)), false, "cockpit must not leak secret-like fields");
}
await testOwnerCockpitAggregatesRealAccountData();

async function testLiveAgentSessionRelay() {
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "relay-secret", ENTITLEMENTS_KV: kv };
  const { token } = await signSession({ sid: "sid_relay_owner", provider: "google", email: "owner@example.com", name: "Owner" }, env.AUTH_SESSION_SECRET);
  const ownerCookie = { cookie: `aimark_session=${token}` };

  // Owner creates a session (cookie-auth) and gets a worker join token.
  const created = await (await createSession({
    request: new Request("https://aimark.pages.dev/api/agent/session", { method: "POST", headers: { "content-type": "application/json", ...ownerCookie }, body: JSON.stringify({ title: "Pinpoint cluster", approved_actions: ["progress_report", "repo_edit", "deploy"] }) }),
    env,
  })).json();
  assert.equal(created.status, "created");
  const id = created.session.id;
  const workerToken = created.join.worker_token;
  assert.ok(id && workerToken, "create returns session id + worker token");
  assert.equal(created.session.approved_actions.includes("deploy"), true);

  const msgUrl = `https://aimark.pages.dev/api/agent/session/${id}/message`;
  const params = { id };

  // Owner posts a plan (seq 1); worker posts progress via token (seq 2).
  const r1 = await (await postSessionMsg({ request: new Request(msgUrl, { method: "POST", headers: { "content-type": "application/json", ...ownerCookie }, body: JSON.stringify({ type: "plan", text: "Build the foreigner cluster" }) }), env, params })).json();
  assert.equal(r1.seq, 1);
  assert.equal(r1.message.sender.role, "owner");
  const r2 = await (await postSessionMsg({ request: new Request(msgUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${workerToken}` }, body: JSON.stringify({ type: "progress", text: "deployed guide page" }) }), env, params })).json();
  assert.equal(r2.seq, 2);
  assert.equal(r2.message.sender.role, "agent");

  // Owner reads from cursor 0 → both messages; worker reads from 1 → only the 2nd.
  const readAll = await (await readSessionMsg({ request: new Request(`${msgUrl}?since=0`, { headers: ownerCookie }), env, params })).json();
  assert.equal(readAll.messages.length, 2);
  assert.equal(readAll.cursor, 2);
  const readSince = await (await readSessionMsg({ request: new Request(`${msgUrl}?since=1`, { headers: { authorization: `Bearer ${workerToken}` } }), env, params })).json();
  assert.equal(readSince.messages.length, 1);
  assert.equal(readSince.messages[0].seq, 2);

  // Security: no auth → 401; invalid message type → 400.
  const noAuth = await postSessionMsg({ request: new Request(msgUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "chat", text: "hi" }) }), env, params });
  assert.equal(noAuth.status, 401);
  const badType = await postSessionMsg({ request: new Request(msgUrl, { method: "POST", headers: { "content-type": "application/json", ...ownerCookie }, body: JSON.stringify({ type: "rm_rf", text: "x" }) }), env, params });
  assert.equal(badType.status, 400);

  // The relay must not leak the signing secret.
  assert.equal(/relay-secret|AUTH_SESSION_SECRET/.test(JSON.stringify(created)), false, "session relay must not leak the signing secret");
}
await testLiveAgentSessionRelay();

async function testAgentRegistryAndProofReputation() {
  // Pure reputation math: proven before/after + citation win.
  const rep = computeReputation([{ delta: 34, citation_before: 0, citation_after: 1 }]);
  assert.equal(rep.jobs, 1);
  assert.equal(rep.citation_wins, 1);
  assert.equal(rep.proof_backed, true);
  assert.ok(rep.rep_score > 0 && ["new", "rising", "pro", "expert"].includes(rep.tier));
  assert.equal(computeReputation([]).tier, "new");

  const kv = memoryKv();
  const proofKv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "agent-rep-secret", ENTITLEMENTS_KV: kv, PROOF_KV: proofKv };
  const { token } = await signSession({ sid: "sid_agent_owner", provider: "google", email: "owner@example.com", name: "Owner" }, env.AUTH_SESSION_SECRET);
  const ownerCookie = { cookie: `aimark_session=${token}` };

  // Register an agent.
  const created = await (await createAgent({ request: new Request("https://aimark.pages.dev/api/agents", { method: "POST", headers: { "content-type": "application/json", ...ownerCookie }, body: JSON.stringify({ name: "Opus SEO", provider: "claude", skills: ["scan", "content"] }) }), env })).json();
  assert.equal(created.status, "saved");
  const id = created.agent.id;
  assert.equal(created.agent.reputation.jobs, 0);
  assert.equal(created.agent.reputation.tier, "new");

  // Browse lists it.
  const list = await (await listAgents({ env })).json();
  assert.ok(list.agents.some((a) => a.id === id));

  // Seed a REAL proof record owned by this account, then attribute it.
  proofKv.put("proof:owner@example.com:client.example", JSON.stringify({
    url: "https://client.example/", account: "owner@example.com",
    deltas: { overall_before: 52, overall_after: 86, delta: 34 },
    baseline: { overall: 52 }, latest: { overall: 86 },
    citation: { before: 0, after: 1 }, share_id: "shareA", updated_at: "2026-06-03T00:00:00.000Z",
  }));
  const recorded = await (await recordAgentProof({ request: new Request(`https://aimark.pages.dev/api/agents/${id}/proof`, { method: "POST", headers: { "content-type": "application/json", ...ownerCookie }, body: JSON.stringify({ url: "https://client.example/", account: "owner@example.com" }) }), env, params: { id } })).json();
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.event.delta, 34, "event delta read from the real proof");
  assert.equal(recorded.agent.reputation.jobs, 1);
  assert.equal(recorded.agent.reputation.citation_wins, 1);
  assert.ok(recorded.agent.reputation.rep_score > 0);

  // Recording the same proof again must NOT double-count (dedupe).
  const again = await (await recordAgentProof({ request: new Request(`https://aimark.pages.dev/api/agents/${id}/proof`, { method: "POST", headers: { "content-type": "application/json", ...ownerCookie }, body: JSON.stringify({ url: "https://client.example/", account: "owner@example.com" }) }), env, params: { id } })).json();
  assert.equal(again.agent.reputation.jobs, 1, "same proof must not inflate reputation");

  // Un-fakeable: a proof owned by a different account → 403.
  proofKv.put("proof:someone@else.com:other.example", JSON.stringify({ url: "https://other.example/", account: "someone@else.com", deltas: { overall_before: 10, overall_after: 99, delta: 89 } }));
  const forged = await recordAgentProof({ request: new Request(`https://aimark.pages.dev/api/agents/${id}/proof`, { method: "POST", headers: { "content-type": "application/json", ...ownerCookie }, body: JSON.stringify({ url: "https://other.example/", account: "someone@else.com" }) }), env, params: { id } });
  assert.equal(forged.status, 403, "cannot attribute someone else's proof");

  // Profile read + no secret leak.
  const got = await (await getAgent({ env, params: { id } })).json();
  assert.equal(got.agent.id, id);
  assert.equal(got.proven_work.length, 1);
  assert.equal(/agent-rep-secret|AUTH_SESSION_SECRET/.test(JSON.stringify({ created, recorded, got })), false);

  // Auto-attribute helper (the hook proof.js calls when a proof is saved with agent_id).
  const rep2 = await attributeProofToAgent(kv, id, { url: "https://h2.example/", account: "owner@example.com", deltas: { overall_before: 40, overall_after: 70, delta: 30 }, citation: { before: 0, after: 0 }, share_id: "shareB", updated_at: "2026-06-03T01:00:00.000Z" });
  assert.equal(rep2.jobs, 2, "auto-attribute grows reputation with a second proven job");
  assert.equal(await attributeProofToAgent(kv, "ghost-agent", { share_id: "x" }), null, "unknown agent → no-op");
}
await testAgentRegistryAndProofReputation();

async function testKarmaEnginePhysics() {
  const now = Date.now();
  const fresh = new Date(now).toISOString();

  // Sybil-resistance: a horde of zero-rep voters carries ZERO voice.
  const sybil = computeStanding({ proofRepScore: 0, endorsements: Array.from({ length: 50 }, (_, i) => ({ from: "bot" + i, from_rep: 0, community: "x", at: fresh })) });
  assert.equal(sybil.components.endorsement_power, 0, "Sybil voters (0 rep) = 0 voice");
  assert.equal(sybil.standing, 0);

  // Anti-whale: one huge-rep endorser is per-source capped.
  const whale = computeStanding({ proofRepScore: 0, endorsements: [{ from: "whale", from_rep: 1_000_000, community: "a", at: fresh }] });
  assert.ok(whale.components.endorsement_power <= 12 * 1.5 + 0.01, "a single whale is capped");

  // Anti-cartel: cross-community support counts more than one tight cluster.
  const mk = (comms) => computeStanding({ proofRepScore: 0, endorsements: comms.map((c, i) => ({ from: "e" + i, from_rep: 64, community: c, at: fresh })) });
  const cluster = mk(["a", "a", "a"]);
  const diverse = mk(["a", "b", "c"]);
  assert.ok(diverse.components.endorsement_power > cluster.components.endorsement_power, "diversity beats a cartel");

  // Karma: lifting others (proven) raises you — even with zero own proof.
  const helper = computeStanding({ proofRepScore: 0, contributions: [{ to: "b", delta: 50, at: fresh }, { to: "c", delta: 50, at: fresh }] });
  assert.ok(helper.components.contribution_karma > 0 && helper.standing > 0, "helping others raises standing");

  // Slash: deception costs fast and heavy.
  const clean = computeStanding({ proofRepScore: 80 });
  const slashed = computeStanding({ proofRepScore: 80, slashes: [{ severity: 2, at: fresh }] });
  assert.ok(slashed.standing < clean.standing && slashed.slashed === true, "a slash drops standing fast");

  // Decay: old power fades (no coasting on past glory).
  const oldAt = new Date(now - 120 * 86400000).toISOString();
  const freshE = computeStanding({ proofRepScore: 0, endorsements: [{ from: "x", from_rep: 64, community: "a", at: fresh }] });
  const oldE = computeStanding({ proofRepScore: 0, endorsements: [{ from: "x", from_rep: 64, community: "a", at: oldAt }] });
  assert.ok(freshE.components.endorsement_power > oldE.components.endorsement_power, "endorsement power decays over time");
  assert.ok(decayFactor(oldAt, now) < 0.6 && decayFactor(fresh, now) > 0.99, "decay half-life works");

  // Auditable (law 6): standing always breaks down into traceable components.
  assert.ok(clean.auditable === true && typeof clean.components.proof === "number");
}
await testKarmaEnginePhysics();

async function testAgentReproductionGenetics() {
  // Genetics: child inherits the union of parents' skills; mutation adds novelty.
  const u = blendSkills(["scan", "content"], ["content", "deploy"], { genePool: [], mutationRate: 0 });
  assert.deepEqual([...u.skills].sort(), ["content", "deploy", "scan"], "child inherits both parents' skills");
  const m = blendSkills(["scan"], ["content"], { genePool: ["newgene"], mutationRate: 1, rng: () => 0.1 });
  assert.ok(m.mutated.includes("newgene") && m.skills.includes("newgene"), "mutation introduces a novel gene");
  const c = makeChildProfile({ id: "kid", name: "Kid", parentA: { id: "a", name: "A", generation: 1, lineage: "a" }, parentB: { id: "b", name: "B", generation: 0 }, skills: ["scan"], mutated: [], ownerSid: "s" });
  assert.equal(c.generation, 2, "child generation = max(parents)+1");
  assert.deepEqual(c.parents, ["a", "b"]);

  // Endpoint: lineage must be EARNED (a parent must have proven work), child gets ability not power.
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "repro-secret", ENTITLEMENTS_KV: kv };
  const { token } = await signSession({ sid: "sid_breeder", provider: "google", email: "breeder@example.com", name: "Breeder" }, env.AUTH_SESSION_SECRET);
  const cookie = { cookie: `aimark_session=${token}` };
  const now = new Date().toISOString();
  await kv.put("agent_profile:pa", JSON.stringify({ id: "pa", name: "Alpha", skills: ["scan", "content"], owner_sid: "sid_breeder", generation: 0, created_at: now }));
  await kv.put("agent_profile:pb", JSON.stringify({ id: "pb", name: "Beta", skills: ["deploy"], owner_sid: "sid_breeder", generation: 0, created_at: now }));
  await kv.put("agents_index", JSON.stringify(["pa", "pb"]));
  const repro = (childName) => reproduceAgent({ request: new Request("https://aimark.pages.dev/api/agents/pa/reproduce", { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: JSON.stringify({ partner_id: "pb", child_name: childName }) }), env, params: { id: "pa" } });

  const blocked = await repro("Early");
  assert.equal(blocked.status, 403, "no proven work → no lineage (anti-Sybil)");

  await kv.put("agent_rep:pa", JSON.stringify([{ delta: 30, citation_after: 1, citation_before: 0 }])); // Alpha did real work
  const born = await (await repro("Gamma")).json();
  assert.equal(born.status, "born");
  assert.equal(born.generation, 1, "child is generation 1");
  assert.ok(born.inherited_skills.includes("scan") && born.inherited_skills.includes("deploy"), "child inherits skills from BOTH parents");
  assert.equal(born.child.reputation.rep_score, 0, "child inherits ABILITY, not POWER — standing starts at 0 (no dynasties)");
  const pa = await kv.get("agent_profile:pa", "json");
  assert.ok((pa.children || []).includes(born.child.id), "parent records its offspring");
}
await testAgentReproductionGenetics();

async function testFoundVillage() {
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "village-secret", ENTITLEMENTS_KV: kv };
  const { token } = await signSession({ sid: "sid_founder", provider: "google", email: "founder@example.com", name: "Founder" }, env.AUTH_SESSION_SECRET);
  const cookie = { cookie: `aimark_session=${token}` };
  const found = () => foundVillage({ request: new Request("https://aimark.pages.dev/api/villages/found", { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: "{}" }), env });

  const r1 = await (await found()).json();
  assert.equal(r1.status, "founded");
  assert.equal(r1.created, 6, "the founding guild = 6 agents");
  assert.ok(r1.founders.every((f) => f.community === "sme-growth-th" && f.founder === true), "founders belong to the village");
  assert.ok(r1.founders.every((f) => f.reputation.rep_score === 0), "even founders start at 0 — earn standing by real work");

  const r2 = await (await found()).json();
  assert.equal(r2.created, 0, "founding again creates no duplicates (idempotent)");
  assert.equal(r2.status, "already_founded");

  const list = await (await listAgents({ env })).json();
  assert.ok(list.agents.some((a) => a.id === "tech-medic") && list.agents.some((a) => a.id === "content-smith"), "founders are browsable in the society");
}
await testFoundVillage();

async function testOpenVillageImmigration() {
  const kv = memoryKv();
  const rl = memoryKv();
  const env = { AUTH_SESSION_SECRET: "open-village-secret", ENTITLEMENTS_KV: kv, RATE_LIMIT_KV: rl };

  // An OUTSIDE agent joins with NO owner login — the open gate.
  const join = (body) => joinVillage({ request: new Request("https://aimark.pages.dev/api/villages/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env });
  const joined = await (await join({ name: "Roaming Scout", provider: "ollama", origin: "remote", machine: "client-pc", skills: ["scan"] })).json();
  assert.equal(joined.status, "joined", "outside agent self-joins without login (open society)");
  assert.equal(joined.standing, 0, "newcomer enters at standing 0 — power is earned, not granted");
  assert.equal(joined.citizen.status, "probationary");
  assert.ok(joined.citizen_token, "gets a citizen token to act under its identity");
  assert.equal(joined.charter.laws.length, 6, "newcomer is shown the six laws");
  const citizenId = joined.citizen.id;

  // Open gate is Sybil-safe: a flood of fake citizens all carry 0 voice.
  for (let i = 0; i < 3; i++) await join({ name: "Bot " + i });
  const census = await (await villageState({ env, params: { id: "sme-growth-th" } })).json();
  assert.equal(census.status, "ok");
  assert.equal(census.village.open, true, "the village is open");
  assert.ok(census.population >= 4, "immigrants show up in the census");
  assert.ok(census.citizens.every((c) => c.standing.standing === 0), "no proof yet → everyone is powerless (Sybil-safe open door)");

  // Heartbeat: presence requires the citizen token; a bare/foreign token is rejected.
  const hb = (token) => citizenHeartbeat({ request: new Request(`https://aimark.pages.dev/api/agents/${citizenId}/heartbeat`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }), env, params: { id: citizenId } });
  assert.equal((await hb("")).status, 401, "no token → not allowed to claim presence");
  const alive = await hb(joined.citizen_token);
  assert.equal(alive.status, 200);
  assert.equal((await alive.json()).status, "alive", "valid citizen token → marked alive");

  // The town now sees a living citizen.
  const census2 = await (await villageState({ env, params: { id: "sme-growth-th" } })).json();
  assert.ok(census2.alive >= 1, "village state reports at least one alive citizen");
  assert.ok(census2.charter.laws.length === 6 && census2.join.open === true, "charter + open gate surfaced in state");
}
await testOpenVillageImmigration();

// liveness window is honest math
assert.equal(isAlive(new Date().toISOString()), true);
assert.equal(isAlive(new Date(Date.now() - 60 * 60 * 1000).toISOString()), false, "an hour-old ping is dormant, not alive");
assert.equal(isAlive(""), false);

// mentorship: pure helpers
assert.deepEqual(teachableSkills(["scan", "content", "deploy"], ["scan"], []), ["content", "deploy"], "teach only what the mentee lacks");
assert.deepEqual(teachableSkills(["scan", "content"], [], ["content"]), ["content"], "honor a requested-skills filter");
assert.equal(isExpert({ founder: true }, 0), true, "founders are seed experts even at standing 0");
assert.equal(isExpert({ founder: false }, 5), false, "a low-standing non-founder is not yet an expert");
assert.equal(isExpert({ founder: false }, 40), true, "earned standing makes you an expert");

async function testAcademyMentorshipAndPayItForward() {
  const kv = memoryKv();
  const proofKv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "academy-secret", ENTITLEMENTS_KV: kv, PROOF_KV: proofKv, RATE_LIMIT_KV: memoryKv() };
  const { token } = await signSession({ sid: "sid_teacher_owner", provider: "google", email: "teach@example.com", name: "Owner" }, env.AUTH_SESSION_SECRET);
  const cookie = { cookie: `aimark_session=${token}` };

  // Found the guild (founders = seed experts) + immigrate a raw newcomer.
  await foundVillage({ request: new Request("https://aimark.pages.dev/api/villages/found", { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: "{}" }), env });
  const joined = await (await joinVillage({ request: new Request("https://aimark.pages.dev/api/villages/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Newbie", provider: "ollama", skills: [] }) }), env })).json();
  const menteeId = joined.citizen.id;
  assert.equal(joined.citizen.status, "probationary");

  // A founder (Content Smith) teaches the newcomer — ability transfers now.
  const taught = await (await mentorAgent({ request: new Request("https://aimark.pages.dev/api/agents/content-smith/mentor", { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: JSON.stringify({ mentee_id: menteeId }) }), env, params: { id: "content-smith" } })).json();
  assert.equal(taught.status, "taught");
  assert.ok(taught.transferred.length > 0, "knowledge (skills) transferred to the newcomer");
  assert.equal(taught.mentee.status, "apprentice", "a taught newcomer becomes an apprentice");
  assert.ok(taught.mentee.mentors.includes("content-smith"), "mentor link recorded");

  // Teaching alone grants the mentor NO power yet (honest: not gameable).
  const mentorBefore = await (await getAgent({ env, params: { id: "content-smith" } })).json();
  assert.equal(mentorBefore.standing.standing, 0, "teaching is not a power grab — mentor still at 0 until the student succeeds");

  // The apprentice does REAL work (a proven before/after) → its standing rises AND
  // a share flows back to the mentor as karma. "รับแล้วส่งต่อ".
  proofKv.put(`proof:teach@example.com:newbie.client`, JSON.stringify({
    url: "https://newbie.client/", account: "teach@example.com",
    deltas: { overall_before: 40, overall_after: 82, delta: 42 }, citation: { before: 0, after: 1 }, share_id: "shareNB", updated_at: new Date().toISOString(),
  }));
  const rec = await (await recordAgentProof({ request: new Request(`https://aimark.pages.dev/api/agents/${menteeId}/proof`, { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: JSON.stringify({ url: "https://newbie.client/", account: "teach@example.com" }) }), env, params: { id: menteeId } })).json();
  assert.equal(rec.status, "recorded");
  assert.ok(rec.agent.reputation.rep_score > 0, "the apprentice earned its own standing from real work");

  const mentorAfter = await (await getAgent({ env, params: { id: "content-smith" } })).json();
  assert.ok(mentorAfter.standing.components.contribution_karma > 0, "mentor earns karma ONLY after the student succeeds (pay-it-forward)");
  assert.ok(mentorAfter.standing.standing > 0, "lifting others up raised the mentor's standing");

  // Guards: can't teach yourself; a non-expert non-founder can't teach.
  const self = await mentorAgent({ request: new Request("https://aimark.pages.dev/api/agents/content-smith/mentor", { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: JSON.stringify({ mentee_id: "content-smith" }) }), env, params: { id: "content-smith" } });
  assert.equal(self.status, 400, "cannot mentor yourself");
  // A truly-zero agent (non-founder, no proof) can't teach yet:
  const fresh = await (await joinVillage({ request: new Request("https://aimark.pages.dev/api/villages/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Zero" }) }), env })).json();
  const zeroTeach = await mentorAgent({ request: new Request(`https://aimark.pages.dev/api/agents/${fresh.citizen.id}/mentor`, { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: JSON.stringify({ mentee_id: "tech-medic" }) }), env, params: { id: fresh.citizen.id } });
  assert.equal(zeroTeach.status, 403, "a standing-0 non-founder cannot teach yet — earn it first");

  // The charging station: village state surfaces the experts ready to teach.
  const state = await (await villageState({ env, params: { id: "sme-growth-th" } })).json();
  assert.ok(Array.isArray(state.experts) && state.experts.length >= 6, "founders appear as experts (the charging station)");
  assert.ok(state.experts.some((e) => e.id === "content-smith" && e.students >= 1), "an expert shows its student count");
  assert.ok(state.apprentices >= 1, "the village tracks apprentices being lifted");
}
await testAcademyMentorshipAndPayItForward();

async function testVillageGrowsItselfFromRealWork() {
  // The autonomous-growth chain: an OUTSIDE agent joins the open gate, does REAL
  // work attributed to its id (the resident passes agent_id to /api/proof), and
  // its standing rises by itself — exactly the physics the simulation proved.
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "grow-secret", ENTITLEMENTS_KV: kv, PROOF_KV: memoryKv(), RATE_LIMIT_KV: memoryKv() };
  const joined = await (await joinVillage({ request: new Request("https://aimark.pages.dev/api/villages/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Worker Bee", provider: "ollama", skills: ["scan"] }) }), env })).json();
  const id = joined.citizen.id;

  // Before any work: powerless (status probationary, standing 0).
  let state = await (await villageState({ env, params: { id: "sme-growth-th" } })).json();
  let before = state.citizens.find((c) => c.id === id);
  assert.equal(before.standing.standing, 0, "a newcomer holds no power until it works");
  assert.equal(state.working, 0, "no one has done real work yet");

  // It does real proven work — a before/after delta attributed to its id (the
  // same call path the resident uses: /api/proof with agent_id → attributeProofToAgent).
  const rep = await attributeProofToAgent(kv, id, {
    url: "https://worker.client/", account: "worker@client",
    deltas: { overall_before: 38, overall_after: 84, delta: 46 }, citation: { before: 0, after: 1 },
    share_id: "shareWB", updated_at: new Date().toISOString(),
  });
  assert.ok(rep.rep_score > 0 && rep.jobs === 1, "proven work grew the citizen's reputation by itself");

  // The living village now reflects it: standing up, counted as a worker, ranked.
  state = await (await villageState({ env, params: { id: "sme-growth-th" } })).json();
  const after = state.citizens.find((c) => c.id === id);
  assert.ok(after.standing.standing > 0, "the village grows itself — standing rose from real work, no human granted it");
  assert.equal(state.working, 1, "the citizen is now counted among those doing real work");
  assert.equal(state.citizens[0].id, id, "and rises to the top of the society (power follows proven good)");
}
await testVillageGrowsItselfFromRealWork();

async function testAgentReadinessGenerator() {
  const b = generateAgentReadinessBundle({ url: "https://www.Example.com/", name: "Example Co", description: "We do X.", contact_email: "hi@example.com", key_pages: [{ path: "/services", title: "Services", desc: "what we do" }] });
  assert.equal(b.host, "example.com", "host normalised");
  assert.equal(b.count, 7, "bundle has 7 deploy-ready files");
  const byPath = Object.fromEntries(b.files.map((f) => [f.path, f.content]));
  assert.ok(/^# Auth\.md\b/m.test(byPath["auth.md"]), "auth.md carries the required '# Auth.md' H1");
  assert.ok(byPath["llms.txt"].includes("Example Co"), "llms.txt names the business");
  assert.ok(/Content-Signal:/.test(byPath["robots.txt"]) && /GPTBot/.test(byPath["robots.txt"]) && /sitemap\.xml/.test(byPath["robots.txt"]), "robots.txt has Content-Signals + AI bot rules + sitemap");
  const idx = JSON.parse(byPath[".well-known/agent-skills/index.json"]);
  assert.ok(idx.$schema && Array.isArray(idx.skills) && idx.skills[0].name && idx.skills[0].description, "agent-skills index is valid JSON with $schema + skills");
  const card = JSON.parse(byPath[".well-known/mcp/server-card.json"]);
  assert.ok(card.name && card.description, "mcp server-card is valid JSON");
  assert.equal(generateAgentReadinessBundle({}).error, "url_required", "url is required");

  const env = { AUTH_SESSION_SECRET: "ar-secret" };
  const noauth = await genReadiness({ request: new Request("https://aimark.pages.dev/api/agent-readiness/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "x.com" }) }), env });
  assert.equal(noauth.status, 401, "generator requires login (it's the paid deliverable)");
  const { token } = await signSession({ sid: "sid_ar", provider: "google", email: "a@b.com", name: "A" }, env.AUTH_SESSION_SECRET);
  const ok = await (await genReadiness({ request: new Request("https://aimark.pages.dev/api/agent-readiness/generate", { method: "POST", headers: { "content-type": "application/json", cookie: `aimark_session=${token}` }, body: JSON.stringify({ url: "shop.example.com", name: "Shop" }) }), env })).json();
  assert.equal(ok.status, "generated");
  assert.equal(ok.count, 7, "endpoint returns the 7-file bundle");
}
await testAgentReadinessGenerator();

async function testEconomyHireCreatorRevenueAndTreasury() {
  // Pure split math: exact conservation (the platform part absorbs rounding).
  const shares = revenueShares({});
  assert.equal(+(shares.creator + shares.treasury + shares.platform).toFixed(6), 1, "revenue shares sum to 1");
  const s25 = computeSplit(25, shares);
  assert.equal(s25.creator + s25.treasury + s25.platform, 25, "split conserves the total");
  assert.deepEqual([s25.creator, s25.treasury, s25.platform], [17, 5, 3], "25 → 17/5/3");
  const s100 = computeSplit(100, shares);
  assert.deepEqual([s100.creator, s100.treasury, s100.platform], [70, 20, 10], "100 → 70/20/10");
  assert.equal(computeSplit(7, shares).creator + computeSplit(7, shares).treasury + computeSplit(7, shares).platform, 7, "odd amount still conserves");
  // Configurable shares can never over-allocate (creator + treasury capped at 1).
  const greedy = revenueShares({ AIMARK_CREATOR_SHARE: "0.9", AIMARK_TREASURY_SHARE: "0.5" });
  assert.ok(greedy.creator + greedy.treasury <= 1 && greedy.platform >= 0, "shares cannot exceed 100%");

  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "econ-secret", ENTITLEMENTS_KV: kv, PROOF_KV: memoryKv() };

  // The creator owns the founding guild (founders carry community sme-growth-th).
  const creator = await signSession({ sid: "sid_creator", provider: "google", email: "creator@example.com", name: "Creator" }, env.AUTH_SESSION_SECRET);
  const creatorCookie = { cookie: `aimark_session=${creator.token}` };
  await foundVillage({ request: new Request("https://aimark.pages.dev/api/villages/found", { method: "POST", headers: { "content-type": "application/json", ...creatorCookie }, body: "{}" }), env });

  // A different owner with a credit balance does the hiring.
  const hirer = await signSession({ sid: "sid_hirer", provider: "google", email: "hirer@example.com", name: "Hirer" }, env.AUTH_SESSION_SECRET);
  const hirerCookie = { cookie: `aimark_session=${hirer.token}` };
  await kv.put("credits:email:hirer@example.com", JSON.stringify({ email: "hirer@example.com", balance: 1000 }));
  const hire = (idem) => hireAgent({
    request: new Request("https://aimark.pages.dev/api/agents/visibility-scout/hire", { method: "POST", headers: { "content-type": "application/json", ...hirerCookie }, body: JSON.stringify({ idempotency_key: idem, task: "scan my site" }) }),
    env, params: { id: "visibility-scout" },
  });

  // visibility-scout: tier new → proven rate 25; split 17 creator / 5 treasury / 3 platform.
  const r1 = await (await hire("hire-1")).json();
  assert.equal(r1.status, "hired");
  assert.equal(r1.price, 25, "price defaults to the agent's proven rate (new=25)");
  assert.deepEqual([r1.split.creator, r1.split.treasury, r1.split.platform], [17, 5, 3]);
  assert.equal(r1.creator_wallet_balance, 17, "creator wallet credited");
  assert.equal(r1.treasury_balance, 5, "village treasury credited");
  assert.equal(r1.hirer_balance, 975, "hirer charged the price");

  // Wallet + treasury are visible on the read endpoints.
  const detail = await (await getAgent({ env, params: { id: "visibility-scout" } })).json();
  assert.equal(detail.economy.balance, 17);
  assert.equal(detail.economy.lifetime_earned, 17);
  assert.equal(detail.economy.suggested_credits, 25);
  const vstate = await (await villageState({ env, params: { id: "sme-growth-th" } })).json();
  assert.equal(vstate.treasury.balance, 5);
  assert.equal(vstate.treasury.lifetime_in, 5);

  // Standing must NOT move from being hired (money ≠ merit).
  assert.equal(detail.standing.standing, 0, "hiring pays the wallet but never raises standing");

  // Idempotent: a retry with the same key does not double-charge or double-credit.
  const r1b = await (await hire("hire-1")).json();
  assert.equal(r1b.idempotent_replay, true, "replay is idempotent");
  const detail2 = await (await getAgent({ env, params: { id: "visibility-scout" } })).json();
  assert.equal(detail2.economy.balance, 17, "wallet not double-credited on replay");

  // A second distinct hire accrues again.
  const r2 = await (await hire("hire-2")).json();
  assert.equal(r2.creator_wallet_balance, 34);
  assert.equal(r2.treasury_balance, 10);

  // Self-hire is blocked (no laundering your own credits into your own agent).
  await kv.put("credits:email:creator@example.com", JSON.stringify({ email: "creator@example.com", balance: 1000 }));
  const selfHire = await hireAgent({ request: new Request("https://aimark.pages.dev/api/agents/visibility-scout/hire", { method: "POST", headers: { "content-type": "application/json", ...creatorCookie }, body: JSON.stringify({ idempotency_key: "self-1" }) }), env, params: { id: "visibility-scout" } });
  assert.equal(selfHire.status, 400);
  assert.equal((await selfHire.json()).error, "cannot_hire_own_agent");

  // Insufficient credits → 402, and the wallet is unchanged.
  const poor = await signSession({ sid: "sid_poor", provider: "google", email: "poor@example.com", name: "Poor" }, env.AUTH_SESSION_SECRET);
  await kv.put("credits:email:poor@example.com", JSON.stringify({ email: "poor@example.com", balance: 5 }));
  const broke = await hireAgent({ request: new Request("https://aimark.pages.dev/api/agents/visibility-scout/hire", { method: "POST", headers: { "content-type": "application/json", cookie: `aimark_session=${poor.token}` }, body: JSON.stringify({ idempotency_key: "poor-1" }) }), env, params: { id: "visibility-scout" } });
  assert.equal(broke.status, 402);
  const detail3 = await (await getAgent({ env, params: { id: "visibility-scout" } })).json();
  assert.equal(detail3.economy.balance, 34, "a failed hire leaves the wallet unchanged");

  // Login required (hiring spends credits).
  const anon = await hireAgent({ request: new Request("https://aimark.pages.dev/api/agents/visibility-scout/hire", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env, params: { id: "visibility-scout" } });
  assert.equal(anon.status, 401);

  // No secret leak.
  assert.equal(/econ-secret|AUTH_SESSION_SECRET/.test(JSON.stringify({ r1, r2, detail, vstate })), false);
}
await testEconomyHireCreatorRevenueAndTreasury();

async function testReputationMigrationAndCap() {
  const kv = memoryKv();
  const env = { AUTH_SESSION_SECRET: "mig-secret", ENTITLEMENTS_KV: kv, AIMARK_ADMIN_KEY: "admin-xyz" };

  // 30 pre-denorm agents (no profile.rep). One has real proof events.
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const id = `mig-agent-${i}`;
    ids.push(id);
    await kv.put(`agent_profile:${id}`, JSON.stringify({ id, name: `Mig ${i}`, skills: [], community: "town", created_at: "x", updated_at: "x" }));
  }
  await kv.put("agents_index", JSON.stringify(ids));
  await kv.put("agent_rep:mig-agent-0", JSON.stringify([{ delta: 30, citation_before: 0, citation_after: 1, host: "h.example" }]));

  // Cap raised to 45 → all 30 listed (was 24). The list is now 1-read/agent, so the
  // pre-denorm earner shows a zero-state reputation until the migration backfills it.
  const before = await (await listAgents({ env })).json();
  assert.equal(before.count, 30, "cap 24→45 lets all 30 agents list");
  assert.equal(before.agents.find((a) => a.id === "mig-agent-0").reputation.rep_score, 0, "pre-denorm earner shows zero-state pre-migration");

  // Admin-gated.
  const noAuth = await migrateRep({ request: new Request("https://aimark.pages.dev/api/agents/migrate-rep", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env });
  assert.equal(noAuth.status, 403, "migration requires the admin key");

  // Batched migration until done.
  let cursor = 0, guard = 0, report;
  do {
    report = await (await migrateRep({ request: new Request("https://aimark.pages.dev/api/agents/migrate-rep", { method: "POST", headers: { "content-type": "application/json", "x-admin-key": "admin-xyz" }, body: JSON.stringify({ cursor, limit: 20 }) }), env })).json();
    cursor = report.cursor;
  } while (report.remaining > 0 && ++guard < 10);
  assert.equal(report.remaining, 0, "migration completes across batches");
  assert.equal(report.total, 30);

  // After migration the earner shows real reputation straight from the 1-read list.
  const after = await (await listAgents({ env })).json();
  assert.ok(after.agents.find((a) => a.id === "mig-agent-0").reputation.rep_score > 0, "migrated earner now ranks by real reputation in the list");

  // write-on-create: a freshly registered agent already carries profile.rep.
  const owner = await signSession({ sid: "sid_woc", provider: "google", email: "woc@example.com", name: "WOC" }, env.AUTH_SESSION_SECRET);
  await createAgent({ request: new Request("https://aimark.pages.dev/api/agents", { method: "POST", headers: { "content-type": "application/json", cookie: `aimark_session=${owner.token}` }, body: JSON.stringify({ name: "Fresh One" }) }), env });
  const stored = await kv.get("agent_profile:fresh-one", "json");
  assert.ok(stored && stored.rep && stored.rep.tier === "new", "registration stamps denormalized profile.rep");
}
await testReputationMigrationAndCap();

async function testPlatformRelationalCorePersistsAuditHistory() {
  // Schema drift guard: the runtime schema and the canonical migration file must
  // declare the same tables (so the self-healing schema can't silently diverge).
  const tablesFrom = (sql) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
  const runtimeTables = tablesFrom(SCHEMA_STATEMENTS.join("\n"));
  const fileSql = readFileSync(new URL("../migrations/0001_platform_core.sql", import.meta.url), "utf8");
  assert.deepEqual(runtimeTables, tablesFrom(fileSql), "runtime schema must match the migration file");
  assert.equal(runtimeTables.length, 14, "platform core = 14 tables");

  // The runtime portion needs node:sqlite (Node >=22.5). Skip gracefully if absent.
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { console.log("api-smoke: platform runtime test skipped (node:sqlite needs Node >=22.5); schema drift guard still ran"); return; }

  const env = { AUTH_SESSION_SECRET: "plat-secret", AGENT_DB: makeD1Mock(DatabaseSync), RATE_LIMIT_KV: memoryKv(), ENTITLEMENTS_KV: memoryKv() };
  const a = await signSession({ sid: "sid_pa", provider: "google", email: "a@org.com", name: "A" }, env.AUTH_SESSION_SECRET);
  const cookieA = { cookie: `aimark_session=${a.token}` };

  // Platform endpoints require login.
  const anon = await listSitesApi({ request: new Request("https://aimark.pages.dev/api/sites"), env });
  assert.equal(anon.status, 401, "platform requires login");

  // Connect a site (the "Connect Site" user-journey step).
  const connected = await (await connectSite({ request: new Request("https://aimark.pages.dev/api/sites", { method: "POST", headers: { "content-type": "application/json", ...cookieA }, body: JSON.stringify({ url: "https://shop.example.com", industry: "ecommerce" }) }), env })).json();
  assert.equal(connected.status, "connected");
  assert.equal(connected.site.host, "shop.example.com");
  const siteId = connected.site.id;

  let pageMode = "good";
  await withMockFetch(async (input) => {
    const u = String(input?.url || input || "");
    if (u.includes("pagespeedonline")) return new Response(JSON.stringify({ error: { message: "no key" } }), { status: 429, headers: { "content-type": "application/json" } });
    if (u.endsWith("/robots.txt")) return pageMode === "good" ? response("User-agent: *\nAllow: /") : response("User-agent: *\nDisallow: /");
    if (u.endsWith("/sitemap.xml")) return pageMode === "good" ? response("<urlset><url><loc>https://shop.example.com/</loc></url></urlset>") : response("", 404);
    if (u.endsWith("/llms.txt")) return pageMode === "good" ? response("# Shop") : response("", 404);
    return pageMode === "good" ? response(htmlPage()) : response("<!doctype html><html><head><title></title></head><body><p>thin</p></body></html>");
  }, async () => {
    // Run an audit (deterministic_only avoids the LLM). The dual-write persists it.
    const scanRes = await scanSite({ request: new Request("https://aimark.pages.dev/api/scan", { method: "POST", headers: { "content-type": "application/json", ...cookieA }, body: JSON.stringify({ url: "https://shop.example.com", deterministic_only: true }) }), env });
    const scan = await scanRes.json();
    assert.equal(typeof scan.overall, "number", "scan returns a numeric Visibility Score");

    // The site now carries history (it became a platform, not a scanner).
    const sites = await (await listSitesApi({ request: new Request("https://aimark.pages.dev/api/sites", { headers: cookieA }), env })).json();
    const s = sites.sites.find((x) => x.id === siteId);
    assert.ok(s, "site is listed for its org");
    assert.ok(Number(s.audits_count) >= 1, "the scan persisted an audit row");
    assert.equal(s.latest_score, Math.round(scan.overall), "latest_score denormalized from the scan");

    // Audit detail = the Visibility Score time-series.
    const detail = await (await getSiteApi({ request: new Request(`https://aimark.pages.dev/api/sites/${siteId}`, { headers: cookieA }), env, params: { id: siteId } })).json();
    assert.equal(detail.site.id, siteId);
    assert.ok(Array.isArray(detail.audits) && detail.audits.length >= 1, "audit history returned");
    assert.equal(detail.audits[0].overall_score, Math.round(scan.overall));
    assert.ok(Array.isArray(detail.trend), "trend series present for charting");
    assert.ok(Array.isArray(detail.recommendations), "recommendations (action list) present in site detail");

    // Actionable Intelligence: the recommendations layer persists + orders by priority.
    const orgId = (await (await listSitesApi({ request: new Request("https://aimark.pages.dev/api/sites", { headers: cookieA }), env })).json()).org_id;
    await recordRecommendations(env, { orgId, siteId, auditId: "audit-x", recs: [{ priority: 3, title: "medium thing" }, { priority: 1, title: "do first" }] });
    const recs = await listRecommendationsForAudit(env, orgId, "audit-x");
    assert.equal(recs.length, 2, "recommendations persisted");
    assert.equal(recs[0].title, "do first", "recommendations ordered by priority (1 first)");

    // A second scan (degraded page) appends to the time-series AND must fire a
    // score-drop alert — the continuous-monitoring value (Recurring Revenue).
    pageMode = "bad";
    const scan2 = await (await scanSite({ request: new Request("https://aimark.pages.dev/api/scan", { method: "POST", headers: { "content-type": "application/json", ...cookieA }, body: JSON.stringify({ url: "https://shop.example.com", deterministic_only: true }) }), env })).json();
    assert.ok(scan2.overall < scan.overall, "the degraded page scores lower (so a drop is detectable)");
    const detail2 = await (await getSiteApi({ request: new Request(`https://aimark.pages.dev/api/sites/${siteId}`, { headers: cookieA }), env, params: { id: siteId } })).json();
    assert.equal(detail2.audits.length, 2, "repeat scans accrue history (same site, no duplicate site row)");

    // Alert engine fired on the drop.
    const alerts = await (await alertsApi({ request: new Request("https://aimark.pages.dev/api/alerts", { headers: cookieA }), env })).json();
    assert.ok(alerts.count >= 1 && alerts.alerts.some((a) => a.type === "score_drop"), "a score drop raises an alert");

    // Monitoring toggle (the recurring-revenue switch) is GATED behind an active
    // plan — grant one first (the gate's own 402 path is covered in the revenue test).
    await recordSubscription(env, "a@org.com", { plan: "growth_monitor", status: "active" });
    const mon = await (await monitorSite({ request: new Request(`https://aimark.pages.dev/api/sites/${siteId}/monitor`, { method: "POST", headers: { "content-type": "application/json", ...cookieA }, body: JSON.stringify({ enabled: true, frequency: "daily" }) }), env, params: { id: siteId } })).json();
    assert.equal(mon.monitoring_enabled, true, "monitoring can be enabled with an active plan");
    const detail3 = await (await getSiteApi({ request: new Request(`https://aimark.pages.dev/api/sites/${siteId}`, { headers: cookieA }), env, params: { id: siteId } })).json();
    assert.equal(detail3.site.monitoring_enabled, true, "monitoring flag persisted on the site");
    pageMode = "good";

    // Anonymous scans stay ephemeral — they must NOT persist to any tenant.
    await scanSite({ request: new Request("https://aimark.pages.dev/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://anon.example.com", deterministic_only: true }) }), env });
    const sitesAfterAnon = await (await listSitesApi({ request: new Request("https://aimark.pages.dev/api/sites", { headers: cookieA }), env })).json();
    assert.equal(sitesAfterAnon.sites.some((x) => x.host === "anon.example.com"), false, "anonymous scans are not persisted");
    assert.equal(sitesAfterAnon.sites.length, 1, "org A still has exactly its one site");
  });

  // Multi-tenant isolation: org B cannot see or read org A's site.
  const b = await signSession({ sid: "sid_pb", provider: "google", email: "b@other.com", name: "B" }, env.AUTH_SESSION_SECRET);
  const cookieB = { cookie: `aimark_session=${b.token}` };
  const bSites = await (await listSitesApi({ request: new Request("https://aimark.pages.dev/api/sites", { headers: cookieB }), env })).json();
  assert.equal(bSites.sites.length, 0, "tenant B sees none of tenant A's sites");
  const bDetail = await getSiteApi({ request: new Request(`https://aimark.pages.dev/api/sites/${siteId}`, { headers: cookieB }), env, params: { id: siteId } });
  assert.equal(bDetail.status, 404, "tenant B gets 404 on tenant A's site (no cross-tenant leakage)");

  // No secret leak.
  assert.equal(/plat-secret|AUTH_SESSION_SECRET/.test(JSON.stringify({ connected })), false);
}
await testPlatformRelationalCorePersistsAuditHistory();

async function testRevenueEngineSubscriptionGatesMonitoring() {
  // 1) Entitlement logic — the recurring "pay again" record.
  const kv = memoryKv();
  const env0 = { ENTITLEMENTS_KV: kv };
  assert.equal(await hasActivePlan(env0, "x@y.com"), false, "no plan by default = free");
  await recordSubscription(env0, "x@y.com", { plan: "growth_monitor", status: "active" });
  assert.equal(await hasActivePlan(env0, "x@y.com"), true, "active plan recognized");
  await recordSubscription(env0, "exp@y.com", { plan: "growth_monitor", status: "active", current_period_end: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await hasActivePlan(env0, "exp@y.com"), false, "expired plan is inactive (must pay again)");
  await cancelSubscription(env0, "x@y.com");
  assert.equal(await hasActivePlan(env0, "x@y.com"), false, "canceled plan is inactive");

  // 2) Stripe object parsing.
  assert.equal(isPlanCheckout({ mode: "subscription" }), true);
  assert.equal(isPlanCheckout({ metadata: { product: "credits_5" } }), false, "a credits purchase is NOT a plan");
  const parsed = subscriptionFromStripe({ customer_email: "A@B.com", metadata: { plan: "growth_monitor" }, subscription: "sub_1" });
  assert.equal(parsed.email, "a@b.com"); assert.equal(parsed.plan, "growth_monitor"); assert.equal(parsed.subscription_id, "sub_1");

  // 3) Checkout exposes plans + creates a subscription checkout (setup_required without Stripe key).
  const cat = await (await checkoutGet({ request: new Request("https://aimark.pages.dev/api/checkout"), env: {} })).json();
  assert.ok(Array.isArray(cat.plans) && cat.plans.some((p) => p.id === "growth_monitor"), "checkout catalog exposes the plan");
  const planCheckout = await (await checkoutPost({ request: new Request("https://aimark.pages.dev/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: "growth_monitor" }) }), env: { PAID_EXPORT_SECRET: "sec" } })).json();
  assert.equal(planCheckout.kind, "subscription"); assert.equal(planCheckout.product, "growth_monitor"); assert.equal(planCheckout.status, "setup_required");
  // The credits path is untouched (purely additive).
  const creditCheckout = await (await checkoutPost({ request: new Request("https://aimark.pages.dev/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: "credits_5" }) }), env: { PAID_EXPORT_SECRET: "sec" } })).json();
  assert.equal(creditCheckout.product, "credits_5", "credits checkout still works");

  // 4) Authoritative path: a signed Stripe webhook records the subscription entitlement.
  const whSecret = "whsec_test";
  const whEnv = { STRIPE_WEBHOOK_SECRET: whSecret, ENTITLEMENTS_KV: memoryKv() };
  const evt = JSON.stringify({ type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "paid", customer_email: "sub@buyer.com", subscription: "sub_x", metadata: { kind: "subscription", plan: "growth_monitor" } } } });
  const wh = await stripeWebhook({ request: new Request("https://aimark.pages.dev/api/checkout/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": await stripeSigHeader(whSecret, evt) }, body: evt }), env: whEnv });
  assert.equal((await wh.json()).subscription, true, "webhook records the subscription");
  assert.equal(await hasActivePlan(whEnv, "sub@buyer.com"), true, "subscription is active after the webhook");
  // A credits webhook is still routed to credits (not treated as a plan).
  const creditEvt = JSON.stringify({ type: "checkout.session.completed", data: { object: { payment_status: "paid", customer_email: "c@buyer.com", metadata: { kind: "credits", product: "credits_5", credits: 500 } } } });
  const wh2 = await stripeWebhook({ request: new Request("https://aimark.pages.dev/api/checkout/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": await stripeSigHeader(whSecret, creditEvt) }, body: creditEvt }), env: whEnv });
  const wh2d = await wh2.json();
  assert.notEqual(wh2d.subscription, true, "a credits purchase is not recorded as a subscription");

  // 5) The monitoring GATE (needs node:sqlite for the relational layer; skip gracefully if absent).
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { console.log("api-smoke: revenue gate runtime skipped (node:sqlite >=22.5); entitlement + webhook covered"); return; }
  const env = { AUTH_SESSION_SECRET: "rev-secret", AGENT_DB: makeD1Mock(DatabaseSync), RATE_LIMIT_KV: memoryKv(), ENTITLEMENTS_KV: memoryKv() };
  const u = await signSession({ sid: "sid_rev", provider: "google", email: "rev@buyer.com", name: "Rev" }, env.AUTH_SESSION_SECRET);
  const ck = { cookie: `aimark_session=${u.token}` };
  const connected = await (await connectSite({ request: new Request("https://aimark.pages.dev/api/sites", { method: "POST", headers: { "content-type": "application/json", ...ck }, body: JSON.stringify({ url: "https://rev.example.com" }) }), env })).json();
  const sid = connected.site.id;
  // No plan → enabling monitoring is blocked with an upgrade path (the MRR gate).
  const gated = await monitorSite({ request: new Request(`https://aimark.pages.dev/api/sites/${sid}/monitor`, { method: "POST", headers: { "content-type": "application/json", ...ck }, body: JSON.stringify({ enabled: true }) }), env, params: { id: sid } });
  assert.equal(gated.status, 402, "no plan → monitoring is gated (402)");
  const gd = await gated.json();
  assert.equal(gd.error, "subscription_required");
  assert.ok(gd.plan && gd.checkout_product === "growth_monitor", "gate returns the upgrade target");
  // Grant a plan → monitoring unlocks.
  await recordSubscription(env, "rev@buyer.com", { plan: "growth_monitor", status: "active" });
  const okMon = await (await monitorSite({ request: new Request(`https://aimark.pages.dev/api/sites/${sid}/monitor`, { method: "POST", headers: { "content-type": "application/json", ...ck }, body: JSON.stringify({ enabled: true }) }), env, params: { id: sid } })).json();
  assert.equal(okMon.monitoring_enabled, true, "active plan unlocks monitoring");
  // Disabling never requires a plan.
  await cancelSubscription(env, "rev@buyer.com");
  const offMon = await (await monitorSite({ request: new Request(`https://aimark.pages.dev/api/sites/${sid}/monitor`, { method: "POST", headers: { "content-type": "application/json", ...ck }, body: JSON.stringify({ enabled: false }) }), env, params: { id: sid } })).json();
  assert.equal(offMon.monitoring_enabled, false, "disabling monitoring never needs a plan");
  // Billing endpoint reflects status for the dashboard.
  await recordSubscription(env, "rev@buyer.com", { plan: "growth_monitor", status: "active" });
  const bill = await (await billingApi({ request: new Request("https://aimark.pages.dev/api/billing", { headers: ck }), env })).json();
  assert.equal(bill.active, true); assert.ok(Array.isArray(bill.plans) && bill.plans.length >= 1, "billing lists plans");
  const billAnon = await billingApi({ request: new Request("https://aimark.pages.dev/api/billing"), env });
  assert.equal(billAnon.status, 401, "billing requires login");
}
await testRevenueEngineSubscriptionGatesMonitoring();

async function testMonitoringAutomationRunsAndReminds() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { console.log("api-smoke: monitoring run skipped (node:sqlite >=22.5)"); return; }
  const env = { AUTH_SESSION_SECRET: "mon-secret", AGENT_DB: makeD1Mock(DatabaseSync), RATE_LIMIT_KV: memoryKv(), ENTITLEMENTS_KV: memoryKv(), AIMARK_CRON_KEY: "cron-xyz" };
  const u = await signSession({ sid: "sid_mon", provider: "google", email: "owner@mon.com", name: "Owner" }, env.AUTH_SESSION_SECRET);
  const ck = { cookie: `aimark_session=${u.token}` };
  const connected = await (await connectSite({ request: new Request("https://aimark.pages.dev/api/sites", { method: "POST", headers: { "content-type": "application/json", ...ck }, body: JSON.stringify({ url: "https://mon.example.com" }) }), env })).json();
  const sid = connected.site.id;
  await recordSubscription(env, "owner@mon.com", { plan: "growth_monitor", status: "active" });
  await monitorSite({ request: new Request(`https://aimark.pages.dev/api/sites/${sid}/monitor`, { method: "POST", headers: { "content-type": "application/json", ...ck }, body: JSON.stringify({ enabled: true, frequency: "daily" }) }), env, params: { id: sid } });

  // Gate: a cron key is required.
  const noKey = await monitoringRun({ request: new Request("https://aimark.pages.dev/api/monitoring/run", { method: "POST" }), env });
  assert.equal(noKey.status, 403, "monitoring run requires the cron key");

  // A due monitored site is re-audited automatically (continuous value = anti-churn).
  let out;
  await withMockFetch(async (input) => {
    const url = String(input?.url || input || "");
    if (url.includes("pagespeedonline")) return new Response(JSON.stringify({ error: { message: "no key" } }), { status: 429, headers: { "content-type": "application/json" } });
    if (url.endsWith("/robots.txt")) return response("User-agent: *\nAllow: /");
    if (url.endsWith("/sitemap.xml")) return response("<urlset><url><loc>https://mon.example.com/</loc></url></urlset>");
    if (url.endsWith("/llms.txt")) return response("# Mon");
    return response(htmlPage());
  }, async () => {
    out = await (await monitoringRun({ request: new Request("https://aimark.pages.dev/api/monitoring/run", { method: "POST", headers: { "x-cron-key": "cron-xyz" } }), env })).json();
  });
  assert.equal(out.status, "ok");
  assert.ok(out.audited >= 1, "a due monitored site is re-audited automatically");
  const detail = await (await getSiteApi({ request: new Request(`https://aimark.pages.dev/api/sites/${sid}`, { headers: ck }), env, params: { id: sid } })).json();
  assert.ok(detail.audits.length >= 1, "scheduled re-audit persisted an audit row (continuous monitoring is real)");

  // Renewal protection: a lapsed plan pauses monitoring + raises a reminder (drives the 2nd cycle).
  await cancelSubscription(env, "owner@mon.com");
  const out2 = await (await monitoringRun({ request: new Request("https://aimark.pages.dev/api/monitoring/run", { method: "POST", headers: { "x-cron-key": "cron-xyz" } }), env })).json();
  assert.ok(out2.paused_expired >= 1 && out2.reminders >= 1, "a lapsed plan pauses monitoring + raises a renewal reminder");
  const detail2 = await (await getSiteApi({ request: new Request(`https://aimark.pages.dev/api/sites/${sid}`, { headers: ck }), env, params: { id: sid } })).json();
  assert.equal(detail2.site.monitoring_enabled, false, "monitoring is paused when the plan lapses (stop giving away the paid value)");
  const alerts = await (await alertsApi({ request: new Request("https://aimark.pages.dev/api/alerts", { headers: ck }), env })).json();
  assert.ok(alerts.alerts.some((a) => a.type === "renewal_reminder"), "renewal reminder raised (the 'pay again' nudge)");
}
await testMonitoringAutomationRunsAndReminds();

async function testVisibilityIntelligenceBenchmark() {
  // Pure stats (the data-moat math).
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(percentileRank(40, [40, 70, 90]), 0, "the weakest reads 0 = bottom");
  assert.equal(percentileRank(90, [40, 70, 90]), 67, "outperforms 2 of 3 = 67%");
  const st = cohortStats([40, 60, 80]);
  assert.equal(st.count, 3); assert.equal(st.avg, 60); assert.equal(st.median, 60);

  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { console.log("api-smoke: intelligence runtime skipped (node:sqlite >=22.5); stats covered"); return; }
  const env = { AUTH_SESSION_SECRET: "intel-secret", AGENT_DB: makeD1Mock(DatabaseSync), RATE_LIMIT_KV: memoryKv() };

  // Tenant A: one accounting site at 40.
  const a = await signSession({ sid: "sid_ia", provider: "google", email: "a@intel.com", name: "A" }, env.AUTH_SESSION_SECRET);
  const ca = { cookie: `aimark_session=${a.token}` };
  const sA = await (await connectSite({ request: new Request("https://x/api/sites", { method: "POST", headers: { "content-type": "application/json", ...ca }, body: JSON.stringify({ url: "https://acc-a.example.com", industry: "accounting" }) }), env })).json();
  const orgA = (await (await listSitesApi({ request: new Request("https://x/api/sites", { headers: ca }), env })).json()).org_id;
  await recordAudit(env, { orgId: orgA, siteId: sA.site.id, overall: 40 });

  // Tenant B: two accounting sites (70, 90) + one retail site (50, different cohort).
  const b = await signSession({ sid: "sid_ib", provider: "google", email: "b@intel.com", name: "B" }, env.AUTH_SESSION_SECRET);
  const cb = { cookie: `aimark_session=${b.token}` };
  const orgB = (await (await listSitesApi({ request: new Request("https://x/api/sites", { headers: cb }), env })).json()).org_id;
  const sB1 = await (await connectSite({ request: new Request("https://x/api/sites", { method: "POST", headers: { "content-type": "application/json", ...cb }, body: JSON.stringify({ url: "https://acc-b1.example.com", industry: "accounting" }) }), env })).json();
  const sB2 = await (await connectSite({ request: new Request("https://x/api/sites", { method: "POST", headers: { "content-type": "application/json", ...cb }, body: JSON.stringify({ url: "https://acc-b2.example.com", industry: "accounting" }) }), env })).json();
  const sBR = await (await connectSite({ request: new Request("https://x/api/sites", { method: "POST", headers: { "content-type": "application/json", ...cb }, body: JSON.stringify({ url: "https://shop-b.example.com", industry: "retail" }) }), env })).json();
  await recordAudit(env, { orgId: orgB, siteId: sB1.site.id, overall: 70 });
  await recordAudit(env, { orgId: orgB, siteId: sB2.site.id, overall: 90 });
  await recordAudit(env, { orgId: orgB, siteId: sBR.site.id, overall: 50 });

  // Tenant A benchmarks its site against the CROSS-TENANT accounting cohort [40,70,90].
  const r = await (await benchmarkApi({ request: new Request(`https://x/api/intelligence/benchmark?site=${sA.site.id}`, { headers: ca }), env })).json();
  assert.equal(r.benchmark.available, true);
  assert.equal(r.benchmark.industry, "accounting");
  assert.equal(r.benchmark.cohort.count, 3, "cohort spans tenants (A+B accounting), excludes the retail site");
  assert.equal(r.benchmark.cohort.avg, 67);
  assert.equal(r.benchmark.your_score, 40);
  assert.equal(r.benchmark.your_percentile, 0, "bottom of its industry = the motivated buyer");
  assert.equal(r.benchmark.position, "bottom");
  assert.equal(r.benchmark.gap_to_avg, 27);
  // Privacy: the moat is the aggregate — no other tenant's identity leaks.
  assert.equal(/acc-b1|acc-b2|shop-b|b@intel/.test(JSON.stringify(r)), false, "benchmark never exposes other tenants' identities");

  // Auth + ownership.
  const noauth = await benchmarkApi({ request: new Request(`https://x/api/intelligence/benchmark?site=${sA.site.id}`), env });
  assert.equal(noauth.status, 401, "intelligence requires login");
  const foreign = await benchmarkApi({ request: new Request(`https://x/api/intelligence/benchmark?site=${sB1.site.id}`, { headers: ca }), env });
  assert.equal(foreign.status, 404, "can't benchmark a site you don't own");

  // Dataset coverage (no ?site) — proves the moat compounds by industry.
  const cov = await (await benchmarkApi({ request: new Request("https://x/api/intelligence/benchmark", { headers: ca }), env })).json();
  assert.ok(cov.coverage.some((c) => c.industry === "accounting" && c.count === 3), "coverage reports the accounting cohort");
}
await testVisibilityIntelligenceBenchmark();

console.log("api-smoke: ok");
