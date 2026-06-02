import { requireSession } from "./_auth.js";

export function checkoutCreditRecordFromSession(obj = {}) {
  const email = String(obj.customer_email || obj.customer_details?.email || "").toLowerCase();
  const sessionId = String(obj.id || "");
  const product = String(obj.metadata?.product || obj.lines?.data?.[0]?.metadata?.product || "credits_5");
  const credits = Math.max(0, Number(obj.metadata?.credits || obj.lines?.data?.[0]?.metadata?.credits || 0) || 0);
  return {
    email,
    session_id: sessionId,
    product,
    kind: obj.metadata?.kind || (credits ? "credits" : "entitlement"),
    credits,
    active: true,
    mode: obj.mode || "payment",
    amount_total: obj.amount_total ?? null,
    currency: obj.currency || null,
    payment_status: obj.payment_status || null,
    paid_at: new Date().toISOString(),
  };
}

function safeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9@._:/|-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 240);
}

export function creditCost(feature) {
  const table = {
    line_oa_growth_kit: 100,
    render_check: 75,
    proof_loop: 50,
    ai_bot_intelligence_loop: 25,
    export_package: 100,
    deploy_apply: 150,
  };
  return Math.max(0, Number(table[String(feature || "")] || 0));
}

export async function checkCreditBalance(request, env, opts = {}) {
  const amount = Math.max(0, Number(opts.amount ?? creditCost(opts.feature)));
  const feature = String(opts.feature || "feature").trim() || "feature";
  const idempotencyKey = safeKey(opts.idempotency_key || opts.idempotencyKey || `${feature}:default`);
  if (!amount) return { ok: true, charged: false, amount: 0, reason: "zero_cost" };
  if (!env.ENTITLEMENTS_KV) return { ok: false, error: "credits_store_not_configured", amount };

  const session = await requireSession(request, env);
  const email = String(session?.email || "").toLowerCase();
  if (!email) return { ok: false, error: "login_required_for_credit_debit", amount };

  const debitKey = `credit:debit:${email}:${idempotencyKey}`;
  const prior = await env.ENTITLEMENTS_KV.get(debitKey, "json").catch(() => null);
  const balanceKey = `credits:email:${email}`;
  const current = (await env.ENTITLEMENTS_KV.get(balanceKey, "json").catch(() => null)) || {};
  const balance = Math.max(0, Number(current.balance || 0));
  if (prior) {
    return {
      ok: true,
      charged: false,
      already_charged: true,
      amount: Number(prior.amount || amount),
      balance,
      debit_id: prior.debit_id || debitKey,
      reason: "idempotent_replay",
    };
  }
  if (balance < amount) {
    return {
      ok: false,
      error: "insufficient_credits",
      amount,
      balance,
      needed: amount - balance,
      checkout_url: "/?modal=credits",
    };
  }
  return {
    ok: true,
    charged: false,
    amount,
    balance,
    before: balance,
    feature,
    reason: "credit_balance_available",
  };
}

export async function consumeCredits(request, env, opts = {}) {
  const amount = Math.max(0, Number(opts.amount ?? creditCost(opts.feature)));
  const feature = String(opts.feature || "feature").trim() || "feature";
  const idempotencyKey = safeKey(opts.idempotency_key || opts.idempotencyKey || `${feature}:default`);
  if (!amount) return { ok: true, charged: false, amount: 0, reason: "zero_cost" };
  if (!env.ENTITLEMENTS_KV) return { ok: false, error: "credits_store_not_configured", amount };

  const session = await requireSession(request, env);
  const email = String(session?.email || "").toLowerCase();
  if (!email) return { ok: false, error: "login_required_for_credit_debit", amount };

  const ttl = 60 * 60 * 24 * 730;
  const debitKey = `credit:debit:${email}:${idempotencyKey}`;
  const prior = await env.ENTITLEMENTS_KV.get(debitKey, "json").catch(() => null);
  const balanceKey = `credits:email:${email}`;
  const current = (await env.ENTITLEMENTS_KV.get(balanceKey, "json").catch(() => null)) || {};
  const balance = Math.max(0, Number(current.balance || 0));
  if (prior) {
    return {
      ok: true,
      charged: false,
      already_charged: true,
      amount: Number(prior.amount || amount),
      balance,
      debit_id: prior.debit_id || debitKey,
      reason: "idempotent_replay",
    };
  }
  if (balance < amount) {
    return {
      ok: false,
      error: "insufficient_credits",
      amount,
      balance,
      needed: amount - balance,
      checkout_url: "/?modal=credits",
    };
  }
  const now = new Date().toISOString();
  const next = {
    ...current,
    email,
    balance: balance - amount,
    lifetime_purchased: Math.max(0, Number(current.lifetime_purchased || 0)),
    lifetime_spent: Math.max(0, Number(current.lifetime_spent || 0)) + amount,
    last_debit_feature: feature,
    last_debit_id: debitKey,
    updated_at: now,
  };
  const debit = {
    debit_id: debitKey,
    email,
    feature,
    amount,
    before: balance,
    after: next.balance,
    idempotency_key: idempotencyKey,
    metadata: opts.metadata || {},
    created_at: now,
  };
  const ledgerKey = `credit:ledger:${email}`;
  const ledger = (await env.ENTITLEMENTS_KV.get(ledgerKey, "json").catch(() => null)) || [];
  const nextLedger = Array.isArray(ledger) ? [...ledger, debit].slice(-50) : [debit];
  await env.ENTITLEMENTS_KV.put(balanceKey, JSON.stringify(next), { expirationTtl: ttl });
  await env.ENTITLEMENTS_KV.put(debitKey, JSON.stringify(debit), { expirationTtl: ttl });
  await env.ENTITLEMENTS_KV.put(ledgerKey, JSON.stringify(nextLedger), { expirationTtl: ttl });
  return {
    ok: true,
    charged: true,
    amount,
    balance: next.balance,
    before: balance,
    debit_id: debitKey,
    feature,
  };
}

export async function recordCheckoutCredits(obj = {}, env = {}) {
  const record = checkoutCreditRecordFromSession(obj);
  let credited = false;
  let alreadyCredited = false;
  if (env.ENTITLEMENTS_KV) {
    const ttl = 60 * 60 * 24 * 365;
    if (record.email) await env.ENTITLEMENTS_KV.put(`ent:email:${record.email}`, JSON.stringify(record), { expirationTtl: ttl });
    if (record.session_id) await env.ENTITLEMENTS_KV.put(`ent:session:${record.session_id}`, JSON.stringify(record), { expirationTtl: ttl });

    if (record.email && record.session_id && record.credits > 0) {
      const sessionKey = `credit:session:${record.session_id}`;
      alreadyCredited = !!(await env.ENTITLEMENTS_KV.get(sessionKey));
      if (!alreadyCredited) {
        const balanceKey = `credits:email:${record.email}`;
        let current = {};
        try { current = (await env.ENTITLEMENTS_KV.get(balanceKey, "json")) || {}; } catch { current = {}; }
        const next = {
          email: record.email,
          balance: Math.max(0, Number(current.balance || 0)) + record.credits,
          lifetime_purchased: Math.max(0, Number(current.lifetime_purchased || 0)) + record.credits,
          currency: record.currency || current.currency || null,
          last_product: record.product,
          last_session_id: record.session_id,
          updated_at: new Date().toISOString(),
        };
        await env.ENTITLEMENTS_KV.put(balanceKey, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 730 });
        await env.ENTITLEMENTS_KV.put(sessionKey, JSON.stringify({
          session_id: record.session_id,
          email: record.email,
          credits: record.credits,
          credited_at: next.updated_at,
        }), { expirationTtl: ttl });
        credited = true;
      }
    }
  }
  return {
    recorded: !!env.ENTITLEMENTS_KV,
    email_keyed: !!record.email,
    product: record.product,
    credits: record.credits,
    amount_total: record.amount_total,
    currency: record.currency,
    payment_status: record.payment_status,
    session_id: record.session_id,
    credited,
    already_credited: alreadyCredited,
  };
}
