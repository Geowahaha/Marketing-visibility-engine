/**
 * Cloudflare Pages Function — POST /api/checkout/webhook  (Stripe webhook)
 * ------------------------------------------------------------------
 * Production-grade entitlement. Stripe calls this after a real payment. We
 * verify the signature (HMAC-SHA256 over `${timestamp}.${rawBody}` using the
 * webhook signing secret), and on a completed checkout we record both the
 * entitlement and credit balance in KV so the buyer's account is unlocked
 * authoritatively — independent of the success redirect.
 *
 * Configure in Stripe Dashboard → Developers → Webhooks → add endpoint
 *   https://<your-site>/api/checkout/webhook
 *   events: checkout.session.completed, checkout.session.async_payment_succeeded,
 *           checkout.session.async_payment_failed
 *
 * Env:
 *   STRIPE_WEBHOOK_SECRET  (required — whsec_...)
 * KV binding:
 *   ENTITLEMENTS_KV        (recommended — stores who paid for what)
 */

import { recordCheckoutCredits } from "../_credits.js";
import { recordSubscription, cancelSubscription, subscriptionFromStripe, isPlanCheckout } from "../_entitlements.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a Stripe-Signature header. Returns true/false. */
async function verifyStripeSignature(header, rawBody, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false; // replay window
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(expected, v1);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const secret = String(env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) return json({ error: "STRIPE_WEBHOOK_SECRET not configured." }, 500);

  const rawBody = await request.text();
  const sigHeader = request.headers.get("stripe-signature") || "";
  const ok = await verifyStripeSignature(sigHeader, rawBody, secret);
  if (!ok) return json({ error: "Invalid signature." }, 400);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON." }, 400); }

  if (event.type === "checkout.session.completed") {
    const obj = event.data?.object || {};
    if (obj.payment_status && obj.payment_status !== "paid") {
      return json({
        received: true,
        pending: true,
        payment_status: obj.payment_status,
        message: "Checkout completed but payment is not paid yet; waiting for async_payment_succeeded.",
      });
    }
    // Recurring PLAN (subscription / one-time pass) → record the plan entitlement, not credits.
    if (isPlanCheckout(obj)) {
      const sub = subscriptionFromStripe(obj);
      const rec = await recordSubscription(env, sub.email, { plan: sub.plan, status: "active", current_period_end: sub.current_period_end, subscription_id: sub.subscription_id, source: sub.source });
      return json({ received: true, event: event.type, subscription: !!rec, plan: sub.plan, email_keyed: !!sub.email });
    }
    const result = await recordCheckoutCredits(obj, env);
    return json({ received: true, event: event.type, ...result });
  }

  if (event.type === "checkout.session.async_payment_succeeded" || event.type === "invoice.paid") {
    const obj = event.data?.object || {};
    // Subscription renewal (invoice.paid for a subscription) or an async plan pass → refresh the plan.
    const isSubInvoice = event.type === "invoice.paid" && (obj.subscription || obj.metadata?.plan || obj.lines?.data?.[0]?.metadata?.plan);
    if (isSubInvoice || (event.type === "checkout.session.async_payment_succeeded" && isPlanCheckout(obj))) {
      const sub = subscriptionFromStripe(obj);
      const rec = await recordSubscription(env, sub.email, { plan: sub.plan, status: "active", current_period_end: sub.current_period_end, subscription_id: sub.subscription_id, source: sub.source });
      return json({ received: true, event: event.type, subscription_renewed: !!rec, plan: sub.plan, email_keyed: !!sub.email });
    }
    const result = await recordCheckoutCredits(obj, env);
    return json({ received: true, event: event.type, ...result });
  }

  if (event.type === "customer.subscription.deleted" || (event.type === "customer.subscription.updated" && ["canceled", "unpaid", "incomplete_expired"].includes(event.data?.object?.status))) {
    const obj = event.data?.object || {};
    const email = String(obj.metadata?.email || obj.customer_email || "").toLowerCase();
    if (email) await cancelSubscription(env, email);
    return json({ received: true, event: event.type, canceled: !!email });
  }

  if (event.type === "checkout.session.async_payment_failed") {
    const obj = event.data?.object || {};
    return json({
      received: true,
      event: event.type,
      payment_failed: true,
      session_id: obj.id || "",
      email_keyed: !!(obj.customer_email || obj.customer_details?.email),
    });
  }

  // Acknowledge everything else so Stripe stops retrying.
  return json({ received: true, ignored: event.type });
}
