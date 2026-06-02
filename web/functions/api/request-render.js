/**
 * Cloudflare Pages Function — POST /api/request-render
 * ------------------------------------------------------------------
 * Demand capture for the premium "Human vs AI-bot view" (Browser Rendering).
 * We keep that feature gated and OFF until a paying customer actually wants it
 * — this records each request so the operator knows when it's worth enabling
 * Workers Paid + BROWSER_API_TOKEN. Paid-gated (only real customers can ask).
 *
 * Stores to ENTITLEMENTS_KV under "feature_requests:render" (capped list).
 */

import { paid } from "./_auth.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await paid(request, env))) {
    return json({ error: "Deep render is part of AI Mark Pro.", upgrade_required: true, checkout_url: "/api/checkout?product=pro" }, 402);
  }
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const entry = {
    url: String(payload.url || "").slice(0, 300),
    contact: String(payload.contact || "").slice(0, 180),
    note: String(payload.note || "").slice(0, 300),
    ip: request.headers.get("CF-Connecting-IP") || "",
    at: new Date().toISOString(),
  };
  let queued = false;
  if (env.ENTITLEMENTS_KV) {
    try {
      const key = "feature_requests:render";
      const raw = await env.ENTITLEMENTS_KV.get(key);
      const arr = raw ? JSON.parse(raw) : [];
      arr.push(entry);
      await env.ENTITLEMENTS_KV.put(key, JSON.stringify(arr.slice(-200)));
      queued = true;
    } catch { /* fall through */ }
  }
  return json({
    ok: true,
    queued,
    message: {
      en: "Request received. We'll enable the deep render for your account and email/LINE you when it's ready.",
      th: "รับคำขอแล้ว เราจะเปิดฟีเจอร์เรนเดอร์เชิงลึกให้บัญชีของคุณ และแจ้งกลับทางอีเมล/LINE เมื่อพร้อม",
    },
  });
}
