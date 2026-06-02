import { paidStatus, requireSession } from "./_auth.js";
import { connectedGithubToken } from "./_github.js";
import { consumeCredits, creditCost } from "./_credits.js";

/**
 * Cloudflare Pages Function — POST /api/deploy  (Lane A: true one-click apply)
 * ------------------------------------------------------------------
 * Pushes the Improve Engine's generated fixes to the client's own stack.
 * The owner connects their OWN token (passed per-request, never stored), so we
 * act on their behalf with their permission.
 *
 * Lanes:
 *   provider: "github"     → commit robots.txt + llms.txt + head snippet to a new
 *                            branch and open a PR (safe, reviewable, reversible).
 *   provider: "cloudflare" → generate + deploy a Worker that injects the head
 *                            block + JSON-LD via HTMLRewriter and serves
 *                            robots.txt/llms.txt (owner still binds the route).
 *   provider: "bundle" (or no token) → return a downloadable file manifest +
 *                            a dead-simple paste guide (Lane B fallback).
 *
 * Body: { provider, artifacts, repo?, branch?, github_token?, account_id?,
 *         api_token?, worker_name?, origin_url? }
 *   artifacts = the `artifacts` object from /api/improve.
 *
 * Paid feature (Fix Pack / Managed). Never logs tokens.
 */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function code(artifacts, key) { return artifacts && artifacts[key] && artifacts[key].code ? String(artifacts[key].code) : ""; }
function b64utf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function originOfRequest(request) {
  try {
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://aimark.pages.dev";
  }
}
function normalizeSiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString();
  } catch {
    return "";
  }
}
function siteOrigin(value) {
  try { return new URL(value).origin; } catch { return ""; }
}

/** Files we know how to drop straight into a repo / host. */
function fileManifest(artifacts) {
  const files = [];
  const robots = code(artifacts, "robots_txt");
  const llms = code(artifacts, "llms_txt");
  const head = code(artifacts, "head_block");
  const jsonld = code(artifacts, "json_ld");
  const faq = code(artifacts, "faq_block");
  if (robots) files.push({ path: "robots.txt", content: robots, note: "Site root. Lets AI search bots crawl + cite you." });
  if (llms) files.push({ path: "llms.txt", content: llms, note: "Site root. Content map for AI engines." });
  if (head || jsonld || faq) {
    const snippet =
      (head ? `<!-- AI Mark: paste inside <head> -->\n${head}\n` : "") +
      (jsonld ? `\n<!-- AI Mark: paste before </head> -->\n${jsonld}\n` : "") +
      (faq ? `\n<!-- AI Mark: paste into the page body (e.g. a FAQ section) -->\n${faq}\n` : "");
    files.push({ path: "aimark/head-snippet.html", content: snippet, note: "Reference snippet: head tags + schema + FAQ block to include in your template." });
  }
  return files;
}

function slugify(s) { return String(s || "page").toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page"; }
function ghContentPath(path) {
  return String(path || "").split("/").map((part) => encodeURIComponent(part)).join("/");
}

/** Turn generated articles into publishable pages + internal links + a hub + sitemap. */
function buildContentBundle(pages, siteUrl) {
  if (!Array.isArray(pages) || !pages.length) return [];
  const base = siteUrl ? String(siteUrl).replace(/\/+$/, "") : "";
  const items = pages.filter((p) => p && p.html).map((p) => ({ slug: slugify(p.slug || p.title), title: p.title || "", meta: p.meta_description || "", html: p.html || "", faq: p.faq_jsonld || "" }));
  if (!items.length) return [];
  const th = (s) => /[฀-๿]/.test(s);
  const files = [];
  // Each page, with an internal-links nav to siblings + hub + homepage (real internal linking).
  for (const it of items) {
    const isTh = th(it.html);
    const related = items.filter((x) => x.slug !== it.slug).slice(0, 6).map((x) => `<li><a href="./${x.slug}.html">${(x.title || x.slug).replace(/</g, "&lt;")}</a></li>`).join("");
    const nav = `\n<nav aria-label="Related" style="margin-top:28px;border-top:1px solid #eee;padding-top:14px"><h2>${isTh ? "บทความที่เกี่ยวข้อง" : "Related pages"}</h2><ul>${related}<li><a href="${base || "/"}">${isTh ? "หน้าแรก" : "Home"}</a></li></ul></nav>`;
    const doc = `<!doctype html>\n<html lang="${isTh ? "th" : "en"}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${(it.title || it.slug).replace(/</g, "&lt;")}</title>\n` +
      (it.meta ? `<meta name="description" content="${it.meta.replace(/"/g, "&quot;")}">\n` : "") + (it.faq || "") +
      `\n</head>\n<body>\n<main style="max-width:760px;margin:0 auto;padding:28px 20px;font-family:system-ui,-apple-system,sans-serif;line-height:1.7">\n${it.html}\n${nav}\n</main>\n</body>\n</html>\n`;
    files.push({ path: `aimark-content/${it.slug}.html`, content: doc, note: "New content page (with internal links). Link to it from your main menu." });
  }
  // Content hub (one place to link from the menu; spreads link equity to all new pages).
  const hubLinks = items.map((x) => `<li><a href="./${x.slug}.html">${(x.title || x.slug).replace(/</g, "&lt;")}</a></li>`).join("");
  files.push({ path: "aimark-content/index.html", content: `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resources</title></head>\n<body><main style="max-width:760px;margin:0 auto;padding:28px 20px;font-family:system-ui,sans-serif"><h1>Resources &amp; Guides</h1><ul>${hubLinks}</ul></main></body></html>\n`, note: "Content hub — add a link to this from your main menu so visitors + AI crawlers discover the new pages." });
  // Sitemap for the new pages (+ homepage) — submit in Search Console / add to robots.txt.
  const now = new Date().toISOString().slice(0, 10);
  const homeUrl = base ? `  <url><loc>${base}/</loc><lastmod>${now}</lastmod></url>\n` : "";
  const urls = items.map((x) => `  <url><loc>${base}/aimark-content/${x.slug}.html</loc><lastmod>${now}</lastmod></url>`).join("\n");
  files.push({ path: "aimark-content/sitemap.xml", content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${homeUrl}${urls}\n</urlset>\n`, note: base ? "Submit this in Google Search Console and add 'Sitemap: <your-domain>/aimark-content/sitemap.xml' to robots.txt so Google + AI find the pages fast." : "Add your domain when generating to get absolute sitemap URLs; submit it in Search Console." });
  return files;
}

function buildProofPlan({ request, provider, siteUrl, files = [], pullRequest = null, workerName = "", status = "" }) {
  const normalized = normalizeSiteUrl(siteUrl);
  const origin = siteOrigin(normalized);
  const appOrigin = originOfRequest(request);
  const expectedPublic = files
    .map((f) => {
      const p = String(f.path || f.filename || "").replace(/^\/+/, "");
      if (!origin || !p) return null;
      if (p === "aimark/head-snippet.html") return null;
      return { file: p, url: `${origin}/${p}`, verify: "GET should return 200 after deploy/merge." };
    })
    .filter(Boolean)
    .slice(0, 12);
  const proofEndpoint = normalized
    ? `${appOrigin}/api/proof?url=${encodeURIComponent(normalized)}`
    : `${appOrigin}/api/proof`;
  const proofPost = normalized
    ? { endpoint: `${appOrigin}/api/proof`, body: { url: normalized, include_citation_probe: true } }
    : { endpoint: `${appOrigin}/api/proof`, body: { url: "<customer-url>", include_citation_probe: true } };
  const mergeRequired = provider === "github" && !!pullRequest;
  const routeRequired = provider === "cloudflare" && (status === "script_ready" || status === "deployed_via_cloudflare_worker");
  return {
    status: "ready",
    provider,
    site_url: normalized || siteUrl || "",
    proof_endpoint: proofEndpoint,
    proof_post: proofPost,
    proof_button_label: { th: "พิสูจน์ผลหลัง apply", en: "Prove after apply" },
    merge_or_publish_required: mergeRequired || routeRequired,
    expected_public_files: expectedPublic,
    apply_evidence: {
      files_prepared: files.map((f) => f.path || f.filename).filter(Boolean),
      pull_request_url: pullRequest?.url || "",
      worker_name: workerName || "",
    },
    checklist: {
      th: [
        mergeRequired ? "Merge Pull Request แล้วรอให้เว็บ deploy เสร็จ" : "นำไฟล์/สคริปต์ไปใช้บนเว็บจริงให้ครบ",
        routeRequired ? "ผูก Cloudflare Worker route กับโดเมนจริง แล้วเปิด URL ลูกค้าตรวจอีกครั้ง" : "เปิดหน้าเว็บจริงแล้ว View Source ตรวจ meta/schema/FAQ ที่เพิ่ม",
        "ตรวจ /robots.txt และ /llms.txt ว่าเปิดได้แบบ public",
        "กด Proof ใน AI Mark เพื่อสแกนซ้ำและเทียบ baseline กับผลหลังแก้",
        "ส่ง proof link ให้ลูกค้า เฉพาะเมื่อผลเป็น verified/provisional ชัดเจนและไม่กล่าวเกินจริง",
      ],
      en: [
        mergeRequired ? "Merge the Pull Request and wait for the site deployment to finish." : "Apply every prepared file/script to the live website.",
        routeRequired ? "Bind the Cloudflare Worker route to the real domain, then open the customer URL again." : "Open the live page and view source to confirm the new meta/schema/FAQ.",
        "Check /robots.txt and /llms.txt publicly.",
        "Run AI Mark Proof to rescan and compare the baseline with the after-fix result.",
        "Share the proof link only with clear verified/provisional status and no overclaiming.",
      ],
    },
    honest_note: "Proof must be re-run after the live site is actually updated. A prepared bundle or PR is not the same as observed public improvement.",
  };
}

/* --------------------------- GitHub lane --------------------------- */
async function gh(token, method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "AI-Mark-Deploy",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function deployGithub({ token, repo, branch, files }) {
  if (!token) {
    return json({
      status: "github_reconnect_required",
      error: "GitHub repo access is not connected.",
      reconnect_url: "/api/github/app/start",
      next_step: "Sign in and approve GitHub repo access, then choose the repository to open a PR.",
    }, 409);
  }
  if (!repo) {
    return json({
      status: "github_repo_required",
      error: "Choose a GitHub repository first.",
      next_step: "Open Account, connect GitHub, select the repository, and press Save.",
    }, 400);
  }
  if (!files.length) return json({ error: "github lane needs deployable artifacts." }, 400);

  // 1. default branch + base SHA
  const repoInfo = await gh(token, "GET", `/repos/${repo}`);
  if (!repoInfo.ok) return json({ error: "Cannot read repo (check token scope `repo` and the repo name).", detail: repoInfo.data?.message, status: repoInfo.status }, 502);
  const base = repoInfo.data.default_branch;
  const baseRef = await gh(token, "GET", `/repos/${repo}/git/ref/heads/${base}`);
  if (!baseRef.ok) return json({ error: "Cannot read base branch ref.", detail: baseRef.data?.message }, 502);
  const baseSha = baseRef.data.object.sha;

  // 2. create the working branch (ignore "already exists")
  const work = branch || "aimark/visibility-fixes";
  const mk = await gh(token, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${work}`, sha: baseSha });
  if (!mk.ok && mk.status !== 422) return json({ error: "Cannot create branch.", detail: mk.data?.message }, 502);

  // 3. write each file on the branch
  const written = [];
  for (const f of files) {
    const contentPath = ghContentPath(f.path);
    const existing = await gh(token, "GET", `/repos/${repo}/contents/${contentPath}?ref=${encodeURIComponent(work)}`);
    const put = await gh(token, "PUT", `/repos/${repo}/contents/${contentPath}`, {
      message: `AI Mark: add/update ${f.path} for AI + search visibility`,
      content: b64utf8(f.content),
      branch: work,
      ...(existing.ok && existing.data?.sha ? { sha: existing.data.sha } : {}),
    });
    written.push({ path: f.path, ok: put.ok, status: put.status, detail: put.ok ? undefined : put.data?.message });
  }
  const failed = written.filter((f) => !f.ok);
  if (failed.length) {
    return json({
      status: "github_files_failed",
      error: "Some files could not be written to GitHub.",
      provider: "github",
      repo,
      branch: work,
      base_branch: base,
      files_written: written,
      files_failed: failed,
      next_step: "Review the failed file details, then retry. No PR was opened because the fix pack is incomplete.",
    }, 207);
  }

  // 4. open a PR (safe + reviewable)
  let pr = null;
  const pull = await gh(token, "POST", `/repos/${repo}/pulls`, {
    title: "AI Mark: AI & search visibility fixes",
    head: work, base,
    body: `Automated by AI Mark.\n\nAdds reviewable files for AI/search visibility:\n\n${files.map((f) => `- ${f.path}: ${f.note || "AI Mark fix"}`).join("\n")}\n\nReview and merge to apply. Re-run AI Mark Proof after deployment to verify before/after lift.`,
  });
  if (pull.ok) pr = { number: pull.data.number, url: pull.data.html_url };
  else if (pull.status !== 422) return json({ error: "Files committed, but PR creation failed.", detail: pull.data?.message, files_written: written }, 207);

  return json({
    status: "deployed_via_github",
    provider: "github",
    repo, branch: work, base_branch: base,
    files_written: written,
    files_failed: [],
    pull_request: pr,
    next_step: pr ? "Review and merge the PR to go live." : "A PR for this branch may already exist — check the repo.",
  });
}

async function connectedGithubAuth(request, env, payload) {
  if (payload.github_token) return { token: payload.github_token, repo: payload.repo || "" };
  const session = await requireSession(request, env);
  if (!session?.sid || !env.ENTITLEMENTS_KV) return { token: "", repo: payload.repo || "" };
  const connected = await connectedGithubToken(env, session);
  if (!connected?.token) return { token: "", repo: payload.repo || "" };
  const selected = await env.ENTITLEMENTS_KV.get(`github:repo:${session.sid}`, "json").catch(() => null);
  return {
    token: connected.token,
    repo: payload.repo || selected?.repo || "",
  };
}

/* ------------------- Cloudflare Worker injector lane ------------------- */
function buildInjectorWorker({ origin, headHtml, jsonLd, robots, llms }) {
  const inject = `${headHtml || ""}\n${jsonLd || ""}`;
  return `// Generated by AI Mark — injects AI/SEO head tags into your live site.
// Bind this Worker to your domain's route in the Cloudflare dashboard.
const ORIGIN = ${JSON.stringify(origin)};
const INJECT = ${JSON.stringify(inject)};
const ROBOTS = ${JSON.stringify(robots || "")};
const LLMS = ${JSON.stringify(llms || "")};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (ROBOTS && url.pathname === "/robots.txt") return new Response(ROBOTS, { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (LLMS && url.pathname === "/llms.txt") return new Response(LLMS, { headers: { "content-type": "text/plain; charset=utf-8" } });
    const upstream = new URL(url.pathname + url.search, ORIGIN);
    const resp = await fetch(upstream, request);
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("text/html") || !INJECT) return resp;
    return new HTMLRewriter()
      .on("head", { element(e) { e.append(INJECT, { html: true }); } })
      .transform(resp);
  }
};
`;
}

async function deployCloudflare({ accountId, apiToken, workerName, script }) {
  if (!accountId || !apiToken) return null; // caller will return the script for manual deploy
  const form = new FormData();
  const metadata = { main_module: "worker.js", compatibility_date: "2024-11-01" };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([script], { type: "application/javascript+module" }), "worker.js");
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName || "aimark-injector")}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${apiToken}` },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

/* ------------------------------ handler ------------------------------ */
export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const status = await paidStatus(request, env, "deploy_locked");
  if (!status.paid) {
    return json({ error: "Auto-deploy uses credits. Add credits to unlock one-click apply.", upgrade_required: true, checkout_url: "/?modal=credits" }, 402);
  }

  const artifacts = payload.artifacts || payload.improve?.artifacts || {};
  const files = [...fileManifest(artifacts), ...buildContentBundle(payload.pages, payload.site_url || payload.origin_url)];
  if (!files.length) return json({ error: "Nothing to deploy. Pass `artifacts` (from /api/improve) or `pages` (from /api/content-engine draft)." }, 400);

  const provider = String(payload.provider || (payload.github_token ? "github" : payload.api_token ? "cloudflare" : "bundle")).toLowerCase();
  const debitForProvider = async () => {
    if (status.reason !== "credit_balance") return null;
    const creditCharge = await consumeCredits(request, env, {
      feature: "deploy_apply",
      amount: creditCost("deploy_apply"),
      idempotency_key: `deploy_apply:${provider}:${payload.repo || payload.origin_url || payload.site_url || "bundle"}:${payload.branch || ""}`,
      metadata: { provider, repo: payload.repo || "", origin_url: payload.origin_url || payload.site_url || "", files: files.map((f) => f.path) },
    });
    if (!creditCharge.ok) {
      return json({
        error: creditCharge.error || "credit_debit_failed",
        upgrade_required: true,
        checkout_url: creditCharge.checkout_url || "/?modal=credits",
        credits_required: creditCharge.amount || creditCost("deploy_apply"),
        credits_balance: creditCharge.balance ?? null,
        credits_needed: creditCharge.needed ?? null,
      }, 402);
    }
    return creditCharge;
  };

  if (provider === "github") {
    const connected = await connectedGithubAuth(request, env, payload);
    if (!connected.token || !connected.repo) {
      return deployGithub({ token: connected.token, repo: connected.repo, branch: payload.branch, files });
    }
    const creditCharge = await debitForProvider();
    if (creditCharge instanceof Response) return creditCharge;
    const response = await deployGithub({ token: connected.token, repo: connected.repo, branch: payload.branch, files });
    const data = await response.json();
    return json({
      ...data,
      paid_reason: status.reason,
      credit_charge: creditCharge,
      proof_plan: buildProofPlan({
        request,
        provider: "github",
        siteUrl: payload.origin_url || payload.site_url,
        files,
        pullRequest: data.pull_request || null,
        status: data.status || "",
      }),
    }, response.status);
  }

  if (provider === "cloudflare") {
    const origin = payload.origin_url;
    if (!origin) return json({ error: "cloudflare lane needs origin_url (your real site origin to proxy)." }, 400);
    const creditCharge = await debitForProvider();
    if (creditCharge instanceof Response) return creditCharge;
    const script = buildInjectorWorker({
      origin,
      headHtml: code(artifacts, "head_block"),
      jsonLd: code(artifacts, "json_ld"),
      robots: code(artifacts, "robots_txt"),
      llms: code(artifacts, "llms_txt"),
    });
    const deployed = await deployCloudflare({ accountId: payload.account_id, apiToken: payload.api_token, workerName: payload.worker_name, script });
    if (!deployed) {
      return json({
        status: "script_ready",
        provider: "cloudflare",
        paid_reason: status.reason,
        credit_charge: creditCharge,
        worker_script: script,
        proof_plan: buildProofPlan({
          request,
          provider: "cloudflare",
          siteUrl: payload.origin_url || payload.site_url,
          files,
          workerName: payload.worker_name || "aimark-injector",
          status: "script_ready",
        }),
        next_step: "Provide account_id + api_token to auto-deploy, or paste this into a new Worker and bind it to your domain route.",
      });
    }
    if (!deployed.ok) return json({ error: "Cloudflare deploy failed.", detail: deployed.data?.errors || deployed.data, worker_script: script }, 502);
    return json({
      status: "deployed_via_cloudflare_worker",
      provider: "cloudflare",
      paid_reason: status.reason,
      credit_charge: creditCharge,
      worker_name: payload.worker_name || "aimark-injector",
      result: deployed.data?.result || true,
      proof_plan: buildProofPlan({
        request,
        provider: "cloudflare",
        siteUrl: payload.origin_url || payload.site_url,
        files,
        workerName: payload.worker_name || "aimark-injector",
        status: "deployed_via_cloudflare_worker",
      }),
      next_step: "In the Cloudflare dashboard, add a route (your-domain/*) to this Worker to make it live.",
    });
  }

  // Lane B fallback: downloadable bundle + paste guide.
  const creditCharge = await debitForProvider();
  if (creditCharge instanceof Response) return creditCharge;
  return json({
    status: "bundle_ready",
    provider: "bundle",
    paid_reason: status.reason,
    credit_charge: creditCharge,
    files: files.map((f) => ({ filename: f.path, content: f.content, where: f.note })),
    proof_plan: buildProofPlan({
      request,
      provider: "bundle",
      siteUrl: payload.origin_url || payload.site_url,
      files,
      status: "bundle_ready",
    }),
    guide: {
      en: ["Upload robots.txt and llms.txt to your website's root folder.", "Open your site template's <head> and paste the head snippet.", "Add the FAQ block to a visible page section.", "Re-run the AI Mark scan to confirm the score went up."],
      th: ["อัปโหลด robots.txt และ llms.txt ไปที่โฟลเดอร์ราก (root) ของเว็บ", "เปิดเทมเพลตเว็บที่ส่วน <head> แล้ววาง head snippet", "นำบล็อก FAQ ไปวางในหน้าที่ผู้ใช้เห็น", "สแกนซ้ำด้วย AI Mark เพื่อยืนยันว่าคะแนนเพิ่มขึ้น"],
    },
    note: "Connect a GitHub repo or Cloudflare token for true one-click apply.",
  });
}
