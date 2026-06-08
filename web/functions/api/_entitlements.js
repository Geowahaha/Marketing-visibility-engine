/**
 * AI Mark — Subscription entitlements (Recurring Revenue engine).
 * ------------------------------------------------------------------
 * The platform already has CREDITS (one-time). This adds the recurring layer:
 * a monthly PLAN that gates the continuous-monitoring value (the reason a
 * customer pays AGAIN). Kept separate from credits and from the working credit
 * ledger — purely additive.
 *
 * Entitlement is keyed by email in ENTITLEMENTS_KV (same store as credits):
 *   sub:email:<email> = { plan, status, current_period_end, subscription_id, source }
 *
 * Thai-first reality: Stripe PromptPay cannot auto-recur, so:
 *   - card       → a real recurring Stripe subscription (true MRR)
 *   - promptpay  → a one-time 30-day "pass" recorded as an active plan (manual renew)
 * Both unlock monitoring; near expiry the alert engine reminds them to renew.
 */

export const PLANS = {
  growth_monitor: {
    id: "growth_monitor",
    name: "Growth Monitor",
    interval: "month",
    price: { thb: 49000, usd: 1500 }, // satang / cents -> ฿490 / $15 per month
    sites: 5,
    tagline: { en: "Keep your AI visibility from slipping", th: "กันไม่ให้การมองเห็นบน AI ตก" },
    features: {
      en: ["Continuous monitoring + score-drop alerts", "Auto re-audit (weekly)", "Up to 5 sites", "Priority 'do this first' recommendations"],
      th: ["เฝ้าดูต่อเนื่อง + แจ้งเตือนเมื่อคะแนนตก", "ออดิทซ้ำอัตโนมัติ (รายสัปดาห์)", "ได้ถึง 5 เว็บไซต์", "คำแนะนำที่ควรทำก่อน"],
    },
  },
};

export function getPlan(id) { return PLANS[String(id || "")] || null; }
export function listPlans() { return Object.values(PLANS); }

export const subKey = (email) => `sub:email:${String(email || "").toLowerCase()}`;

const GRACE_DAYS = 32; // fallback period when Stripe doesn't hand us an exact period end
const PASS_DAYS = 30;  // a PromptPay one-time pass buys 30 days

/** The active plan for an email, or null. Active = status active AND not expired. */
export async function getActivePlan(env, email) {
  if (!env || !env.ENTITLEMENTS_KV || !email) return null;
  const rec = await env.ENTITLEMENTS_KV.get(subKey(email), "json").catch(() => null);
  if (!rec) return null;
  const notExpired = !rec.current_period_end || new Date(rec.current_period_end).getTime() > Date.now();
  return (rec.status === "active" && notExpired) ? rec : null;
}

export async function hasActivePlan(env, email) {
  return !!(await getActivePlan(env, email));
}

/** Write/refresh a subscription entitlement. Best-effort. */
export async function recordSubscription(env, email, opts = {}) {
  if (!env || !env.ENTITLEMENTS_KV || !email) return null;
  const now = Date.now();
  let periodEnd = opts.current_period_end || null;
  if (!periodEnd) {
    const days = opts.source === "promptpay" ? PASS_DAYS : GRACE_DAYS;
    periodEnd = new Date(now + days * 86400000).toISOString();
  }
  const rec = {
    email: String(email).toLowerCase(),
    plan: opts.plan || "growth_monitor",
    status: opts.status || "active",
    current_period_end: periodEnd,
    subscription_id: opts.subscription_id || "",
    source: opts.source || "stripe",
    updated_at: new Date(now).toISOString(),
  };
  await env.ENTITLEMENTS_KV.put(subKey(email), JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 400 });
  return rec;
}

/** Mark a subscription canceled/expired (keeps the row for history). */
export async function cancelSubscription(env, email) {
  if (!env || !env.ENTITLEMENTS_KV || !email) return null;
  const rec = (await env.ENTITLEMENTS_KV.get(subKey(email), "json").catch(() => null)) || { email: String(email).toLowerCase() };
  rec.status = "canceled";
  rec.updated_at = new Date().toISOString();
  await env.ENTITLEMENTS_KV.put(subKey(email), JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 400 });
  return rec;
}

/** Pull subscription fields out of a Stripe object (checkout.session or invoice). */
export function subscriptionFromStripe(obj = {}) {
  const email = String(obj.customer_email || obj.customer_details?.email || "").toLowerCase();
  const plan = obj.metadata?.plan || obj.lines?.data?.[0]?.metadata?.plan || "growth_monitor";
  let periodEnd = null;
  const cpe = obj.current_period_end || obj.lines?.data?.[0]?.period?.end;
  if (cpe) periodEnd = new Date(Number(cpe) * 1000).toISOString();
  const source = obj.metadata?.method === "promptpay" ? "promptpay" : "stripe";
  return { email, plan, current_period_end: periodEnd, subscription_id: obj.subscription || obj.id || "", source };
}

/** Is this Stripe object a PLAN purchase (vs a credits purchase)? */
export function isPlanCheckout(obj = {}) {
  return obj.mode === "subscription" || obj.metadata?.kind === "subscription" || obj.metadata?.kind === "plan_pass" || !!obj.metadata?.plan;
}

export function publicPlanStatus(activeRec) {
  if (!activeRec) return { active: false, plan: null };
  return {
    active: true,
    plan: activeRec.plan,
    plan_name: getPlan(activeRec.plan)?.name || activeRec.plan,
    current_period_end: activeRec.current_period_end || null,
    source: activeRec.source || "stripe",
  };
}
