/**
 * Cloudflare Pages Function — /api/checkout
 * ------------------------------------------------------------------
 * Credit-based monetization for AI Mark. Credits are one-time purchases
 * like xAI-style top ups, replacing the old monthly Starter/Growth/Pro ladder.
 *
 *   GET  /api/checkout
 *        → returns credit packs + provider readiness.
 *
 *   POST /api/checkout { product:"credits_5"|"credits_10"|"credits_20"|"custom",
 *                        custom_amount?, email? }
 *        → creates a Stripe Checkout Session when configured, otherwise
 *          returns a test confirmation URL so the flow can be exercised.
 *
 *   GET  /api/checkout?action=confirm&token=...
 *        → validates the signed success token and unlocks paid features in
 *          this browser. Stripe webhook records the authoritative credit
 *          balance in ENTITLEMENTS_KV when Stripe calls back.
 */

import { paidCookieHeader, signPaidAccessToken } from "./_auth.js";
import { recordCheckoutCredits } from "./_credits.js";

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

const CREDIT_PACKS_USD = {
  credits_5: {
    name: "AI Mark Credits",
    label: "$5",
    amount: 500,
    credits: 500,
    recommended: true,
    tagline: { en: "Recommended starter scan pack", th: "แพ็กเริ่มต้นที่แนะนำ" },
    blurb: {
      en: "Enough for lead scouting, scans, and a first fix package.",
      th: "พอสำหรับหา lead, สแกน และสร้างแพ็กแก้รอบแรก",
    },
  },
  credits_10: {
    name: "AI Mark Credits",
    label: "$10",
    amount: 1000,
    credits: 1100,
    tagline: { en: "Starter outreach queue", th: "คิว outreach เริ่มต้น" },
    blurb: {
      en: "Extra credits for more SME scans and outreach preparation.",
      th: "เครดิตเพิ่มสำหรับสแกน SME และเตรียมข้อความขายมากขึ้น",
    },
  },
  credits_20: {
    name: "AI Mark Credits",
    label: "$20",
    amount: 2000,
    credits: 2400,
    tagline: { en: "Builder pack for same-day selling", th: "แพ็ก Builder สำหรับขายภายในวันเดียว" },
    blurb: {
      en: "Best for scanning a batch of weak sites and preparing client proof.",
      th: "เหมาะกับสแกนเว็บอ่อนหลายรายและเตรียม proof ให้ลูกค้า",
    },
  },
};

const CREDIT_PACKS_THB = {
  credits_5: {
    name: "AI Mark Credits",
    label: "฿199",
    amount: 19900,
    credits: 500,
    recommended: true,
    tagline: { en: "PromptPay starter scan pack", th: "แพ็กเริ่มต้นสำหรับสแกน PromptPay" },
    blurb: {
      en: "Enough for lead scouting, scans, and a first fix package.",
      th: "พอสำหรับหา lead, สแกน และสร้างแพ็กแก้รอบแรก",
    },
  },
  credits_10: {
    name: "AI Mark Credits",
    label: "฿399",
    amount: 39900,
    credits: 1100,
    tagline: { en: "Starter outreach queue", th: "คิว outreach เริ่มต้น" },
    blurb: {
      en: "Extra credits for more SME scans and outreach preparation.",
      th: "เครดิตเพิ่มสำหรับสแกน SME และเตรียมข้อความขายมากขึ้น",
    },
  },
  credits_20: {
    name: "AI Mark Credits",
    label: "฿799",
    amount: 79900,
    credits: 2400,
    tagline: { en: "Builder pack for same-day selling", th: "แพ็ก Builder สำหรับขายภายในวันเดียว" },
    blurb: {
      en: "Best for scanning a batch of weak sites and preparing client proof.",
      th: "เหมาะกับสแกนเว็บอ่อนหลายรายและเตรียม proof ให้ลูกค้า",
    },
  },
};

const FREE_TIER = {
  name: "Free Scan",
  amount: 0,
  credits: 0,
  tagline: { en: "Find the first gap", th: "หา gap แรกก่อน" },
  features: {
    en: ["Visibility scan", "Lead scout preview", "Top fixes preview", "Local agent bridge"],
    th: ["สแกน visibility", "พรีวิว lead scout", "พรีวิวจุดแก้หลัก", "เชื่อม local agent"],
  },
};

function checkoutCurrency(env) {
  return (env.CHECKOUT_CURRENCY || "usd").toLowerCase();
}

function creditPacks(env) {
  return checkoutCurrency(env) === "thb" ? CREDIT_PACKS_THB : CREDIT_PACKS_USD;
}

function configuredProviders(env) {
  const providers = [];
  if (env.STRIPE_SECRET_KEY) providers.push("stripe");
  if (env.OMISE_SECRET_KEY) providers.push("omise");
  if (env.LINEPAY_CHANNEL_ID && env.LINEPAY_CHANNEL_SECRET) providers.push("linepay");
  return providers;
}

function paymentMethods(env) {
  const currency = checkoutCurrency(env);
  const methods = [];
  if (env.STRIPE_SECRET_KEY) {
    methods.push({ id: "card", label: "Card / Apple Pay", provider: "stripe" });
    if (currency === "thb") methods.push({ id: "promptpay", label: "PromptPay QR", provider: "stripe" });
  }
  return methods;
}

function originOf(request, env) {
  if (env.SITE_ORIGIN) return String(env.SITE_ORIGIN).replace(/\/+$/, "");
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function displayAmount(amount) {
  return amount / 100;
}

function resolveProduct(product, payload = {}, env = {}) {
  const packs = creditPacks(env);
  const currency = checkoutCurrency(env);
  const key = String(product || "credits_5");
  if (key !== "custom") return { key, item: packs[key] || null };

  const major = Number(payload.custom_amount || payload.amount || 0);
  const min = currency === "thb" ? 199 : 5;
  const max = currency === "thb" ? 20000 : 500;
  const symbol = currency === "thb" ? "฿" : "$";
  if (!Number.isFinite(major) || major < min) {
    return { key, error: `Custom credit amount must be at least ${symbol}${min}.` };
  }
  if (major > max) {
    return { key, error: `Custom credit amount cannot exceed ${symbol}${max} in one checkout.` };
  }
  const cents = Math.round(major * 100);
  const credits = currency === "thb" ? Math.round((major / 199) * 500) : Math.round(major * 100);
  return {
    key,
    item: {
      name: "AI Mark Custom Credits",
      label: `${symbol}${major.toFixed(2).replace(/\.00$/, "")}`,
      amount: cents,
      credits,
      tagline: { en: "Custom top up", th: "เติมเครดิตเอง" },
      blurb: { en: "Custom AI Mark credit purchase.", th: "เติมเครดิต AI Mark ตามจำนวนที่ต้องการ" },
    },
  };
}

async function signToken(resolved, secret, ttlSec = 1800, env = {}) {
  const product = typeof resolved === "string" ? resolved : resolved.key;
  const item = typeof resolved === "object" ? (resolved.item || {}) : {};
  const credits = Math.max(0, Number(item.credits || 0));
  const amount = Math.max(0, Number(item.amount || 0));
  const currency = checkoutCurrency(env).toUpperCase();
  const body = [product, credits, amount, currency, Date.now() + ttlSec * 1000].join(".");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${btoa(body).replace(/=+$/g, "")}.${sigHex}`;
}

async function verifyToken(token, secret) {
  try {
    const [b64, sigHex] = String(token || "").split(".");
    if (!b64 || !sigHex) return null;
    const body = atob(b64);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const expect = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (expect !== sigHex) return null;
    const parts = body.split(".");
    if (parts.length >= 5) {
      const [product, credits, amount, currency, expiry] = parts;
      if (Number(expiry) < Date.now()) return null;
      return {
        product,
        credits: Math.max(0, Number(credits || 0)),
        amount: Math.max(0, Number(amount || 0)),
        currency: currency || "",
      };
    }
    const [product, expiry] = parts;
    if (Number(expiry) < Date.now()) return null;
    return { product };
  } catch {
    return null;
  }
}

function checkoutReturnParams(ok, env, sessionId = "") {
  const resolved = resolveProduct(ok.product || "credits_5", {}, env);
  const credits = Math.max(0, Number(ok.credits || resolved.item?.credits || 0));
  const amount = Math.max(0, Number(ok.amount || resolved.item?.amount || 0));
  const currency = String(ok.currency || checkoutCurrency(env).toUpperCase()).toUpperCase();
  const params = new URLSearchParams({
    checkout: "success",
    product: ok.product,
    credited: String(credits),
    amount: String(amount),
    currency,
    credits_pending: "1",
  });
  if (sessionId) params.set("session_id", sessionId);
  return `/?${params.toString()}`;
}

async function createStripeSession(env, resolved, origin, opts = {}) {
  const { email, token, method } = opts;
  const { key: product, item } = resolved;
  const currency = checkoutCurrency(env);
  const usePromptPay = method === "promptpay" && currency === "thb";
  if (method === "promptpay" && !usePromptPay) {
    return { ok: false, status: 400, error: "PromptPay QR requires CHECKOUT_CURRENCY=thb." };
  }

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${origin}/api/checkout?action=confirm&session_id={CHECKOUT_SESSION_ID}&token=${encodeURIComponent(token)}&product=${encodeURIComponent(product)}`);
  params.set("cancel_url", `${origin}/?checkout=cancelled`);
  params.set("metadata[kind]", "credits");
  params.set("metadata[product]", product);
  params.set("metadata[credits]", String(item.credits));
  if (email) params.set("customer_email", email);

  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", currency);
  params.set("line_items[0][price_data][product_data][name]", `${item.label} ${item.name}`);
  params.set("line_items[0][price_data][product_data][description]", `${item.credits} AI Mark credits`);
  params.set("line_items[0][price_data][unit_amount]", String(item.amount));
  params.set("payment_method_types[0]", usePromptPay ? "promptpay" : "card");

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) return { ok: false, status: resp.status, error: data.error?.message || "stripe_error" };
  return { ok: true, url: data.url, id: data.id };
}

async function retrieveStripeSession(env, sessionId) {
  if (!env.STRIPE_SECRET_KEY || !sessionId) return { ok: false, skipped: true };
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, status: resp.status, error: data.error?.message || `stripe_session_${resp.status}` };
  return { ok: true, session: data };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.searchParams.get("action") === "status") {
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    if (!sessionId) return json({ error: "session_id_required" }, 400);
    let entitlement = env.ENTITLEMENTS_KV ? await env.ENTITLEMENTS_KV.get(`ent:session:${sessionId}`, "json").catch(() => null) : null;
    let credit = env.ENTITLEMENTS_KV ? await env.ENTITLEMENTS_KV.get(`credit:session:${sessionId}`, "json").catch(() => null) : null;
    let reconciled = null;
    if (!credit && !entitlement) {
      const stripe = await retrieveStripeSession(env, sessionId);
      if (stripe.ok && stripe.session) {
        const paid = stripe.session.payment_status === "paid";
        const expectedCredits = Math.max(0, Number(stripe.session.metadata?.credits || 0) || 0);
        if (paid) {
          reconciled = await recordCheckoutCredits(stripe.session, env);
          entitlement = env.ENTITLEMENTS_KV ? await env.ENTITLEMENTS_KV.get(`ent:session:${sessionId}`, "json").catch(() => null) : null;
          credit = env.ENTITLEMENTS_KV ? await env.ENTITLEMENTS_KV.get(`credit:session:${sessionId}`, "json").catch(() => null) : null;
          if (!env.ENTITLEMENTS_KV) {
            return json({
              status: "paid_unrecorded",
              recorded: false,
              credited: false,
              payment_confirmed: true,
              session_id: sessionId,
              product: stripe.session.metadata?.product || "",
              credits: expectedCredits,
              amount_total: stripe.session.amount_total ?? null,
              currency: stripe.session.currency || "",
              payment_status: stripe.session.payment_status || "",
              message: "Stripe confirms payment, but ENTITLEMENTS_KV is not configured so AI Mark cannot persist credits.",
            });
          }
        } else {
          return json({
            status: "payment_pending",
            recorded: false,
            credited: false,
            payment_confirmed: false,
            session_id: sessionId,
            product: stripe.session.metadata?.product || "",
            credits: expectedCredits,
            amount_total: stripe.session.amount_total ?? null,
            currency: stripe.session.currency || "",
            payment_status: stripe.session.payment_status || "",
            message: "Stripe checkout exists but payment is not paid yet; PromptPay may still be processing.",
          });
        }
      } else if (stripe.error) {
        return json({
          status: "stripe_lookup_failed",
          recorded: false,
          credited: false,
          session_id: sessionId,
          error: stripe.error,
        }, 200);
      }
    }
    return json({
      status: entitlement ? "recorded" : "pending",
      recorded: !!entitlement,
      credited: !!credit,
      payment_confirmed: !!entitlement && (!entitlement.payment_status || entitlement.payment_status === "paid"),
      reconciled_from_stripe: !!reconciled,
      already_credited: !!reconciled?.already_credited,
      session_id: sessionId,
      product: entitlement?.product || "",
      credits: Number(credit?.credits || entitlement?.credits || 0),
      amount_total: entitlement?.amount_total ?? null,
      currency: entitlement?.currency || "",
      payment_status: entitlement?.payment_status || "",
      email_keyed: !!credit?.email,
      credited_at: credit?.credited_at || "",
    });
  }

  if (url.searchParams.get("action") === "confirm") {
    const secret = String(env.PAID_EXPORT_SECRET || "").trim();
    if (!secret) return json({ error: "PAID_EXPORT_SECRET not configured; cannot unlock." }, 500);
    const ok = await verifyToken(url.searchParams.get("token"), secret);
    if (!ok) {
      return new Response(null, { status: 302, headers: { location: "/?checkout=invalid" } });
    }
    const paidToken = await signPaidAccessToken({
      product: ok.product,
      credits: ok.credits,
      source: "checkout_success",
    }, secret);
    const cookie = paidCookieHeader(paidToken);
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    return new Response(null, {
      status: 302,
      headers: { location: checkoutReturnParams(ok, env, sessionId), "set-cookie": cookie },
    });
  }

  if (url.searchParams.get("action") === "redeem") {
    const secret = String(env.PAID_EXPORT_SECRET || "").trim();
    if (!secret) return json({ ok: false, error: "PAID_EXPORT_SECRET not configured." }, 500);
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();
    const valid = String(env.PROMO_CODES || "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (!code || !valid.includes(code)) {
      return json({ ok: false, error: "invalid_code", message: { en: "Invalid or expired promo code.", th: "รหัสโปรโมชันไม่ถูกต้องหรือหมดอายุ" } }, 200);
    }
    const paidToken = await signPaidAccessToken({ product: "promo", source: `promo:${code}` }, secret);
    const cookie = paidCookieHeader(paidToken);
    return json({ ok: true, unlocked: true, code, message: { en: "Promo code accepted — paid features unlocked on this browser.", th: "ใช้รหัสได้แล้ว — ปลดล็อกฟีเจอร์ชำระเงินในเบราว์เซอร์นี้" } }, 200, { "set-cookie": cookie });
  }

  const product = url.searchParams.get("product");
  const providers = configuredProviders(env);
  const currency = checkoutCurrency(env).toUpperCase();
  const methods = paymentMethods(env);
  if (product) {
    const resolved = resolveProduct(product, {}, env);
    if (!resolved.item) return json({ error: "Unknown product." }, 400);
    return json({
      product: resolved.key,
      ...resolved.item,
      display_amount: displayAmount(resolved.item.amount),
      currency,
      providers,
      payment_methods: methods,
      ready: providers.length > 0,
      billing_model: "credits",
    });
  }
  return json({
    free_tier: { ...FREE_TIER, display_amount: 0 },
    catalog: Object.fromEntries(Object.entries(creditPacks(env)).map(([k, v]) => [k, { ...v, display_amount: displayAmount(v.amount) }])),
    order: ["credits_5", "credits_10", "credits_20"],
    currency,
    providers,
    payment_methods: methods,
    ready: providers.length > 0,
    billing_model: "credits",
    credit_unit: "AI Mark credits",
    note: providers.length ? "Payment provider configured." : "No payment provider configured yet — set STRIPE_SECRET_KEY to take live credit payments.",
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

  const resolved = resolveProduct(payload.product || "credits_5", payload, env);
  if (resolved.error) return json({ error: resolved.error }, 400);
  if (!resolved.item) return json({ error: "Unknown product." }, 400);

  const secret = String(env.PAID_EXPORT_SECRET || "").trim();
  if (!secret) return json({ error: "PAID_EXPORT_SECRET not configured." }, 500);

  const origin = originOf(request, env);
  const token = await signToken(resolved, secret, 1800, env);

  if (env.STRIPE_SECRET_KEY) {
    const session = await createStripeSession(env, resolved, origin, {
      email: payload.email,
      token,
      method: payload.method,
    });
    if (!session.ok) return json({ error: "Could not create checkout session.", detail: session.error }, session.status || 502);
    return json({
      status: "ok",
      provider: "stripe",
      product: resolved.key,
      credits: resolved.item.credits,
      amount: resolved.item.amount,
      currency: (env.CHECKOUT_CURRENCY || "usd").toUpperCase(),
      session_id: session.id,
      checkout_url: session.url,
    });
  }

  return json({
    status: "setup_required",
    product: resolved.key,
    ...resolved.item,
    display_amount: displayAmount(resolved.item.amount),
    setup: "Set STRIPE_SECRET_KEY to take live credit payments.",
    test_confirm_url: `${origin}/api/checkout?action=confirm&token=${encodeURIComponent(token)}&product=${encodeURIComponent(resolved.key)}`,
  });
}
