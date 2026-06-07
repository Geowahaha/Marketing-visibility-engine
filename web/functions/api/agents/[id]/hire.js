/**
 * POST /api/agents/:id/hire  — the Economy Layer's atomic primitive.
 * ------------------------------------------------------------------
 * A logged-in owner hires an agent for a unit of work. The hirer's credits are
 * debited (reusing the _credits ledger, idempotent) and split:
 *   creator  → the agent's wallet   (Creator Revenue)
 *   treasury → the agent's village  (community fund / L11)
 *   platform → sustainability
 *
 * Price defaults to the agent's PROVEN "ค่าตัว" (reputation.suggested_credits), so
 * a higher-reputation agent really does command a higher rate. The hire does NOT
 * move standing — being hired ≠ doing good work (standing rises only from proof).
 *
 * Idempotency: pass `idempotency_key` to make retries safe. The credit debit and
 * the wallet credit share that key, and the wallet is credited only on the single
 * real charge → a retry or a race can never double-pay the creator.
 *
 * Body: { task?, url?, price?, idempotency_key? }
 * Auth: owner cookie (the hirer is spending credits).
 */
import { requireSession } from "../../_auth.js";
import { agentKv } from "../../_agent.js";
import { agentProfileKey, agentRepKey, computeReputation, publicProfile } from "../../_agents_registry.js";
import { consumeCredits } from "../../_credits.js";
import { revenueShares, computeSplit, creditWallet, creditTreasury, readWallet, readTreasury, hireKey } from "../../_economy.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" };
const jc = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });

const MAX_PRICE = 100000; // sanity ceiling on a single hire

export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env, params }) {
  const session = await requireSession(request, env);
  if (!session) return jc({ error: "login_required", detail: "Hiring spends credits, so the hirer must be signed in." }, 401);

  const kv = agentKv(env);
  if (!kv) return jc({ error: "agent_kv_not_configured" }, 500);
  if (!env.ENTITLEMENTS_KV) return jc({ error: "credits_store_not_configured" }, 500);

  const id = String(params.id || "");
  const profile = await kv.get(agentProfileKey(id), "json");
  if (!profile) return jc({ error: "agent_not_found" }, 404);

  // Wash-trade guard: you can't move your own credits into your own agent's wallet.
  if (profile.owner_sid && profile.owner_sid === session.sid) {
    return jc({ error: "cannot_hire_own_agent", detail: "Hire another creator's agent — self-hiring would just launder your own credits." }, 400);
  }

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  // Price = the agent's proven rate, unless the hirer explicitly offers a price.
  const reputation = profile.rep || computeReputation((await kv.get(agentRepKey(id), "json")) || []);
  const suggested = Math.max(1, Number(reputation.suggested_credits) || 25);
  let price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) price = suggested;
  price = Math.max(1, Math.min(MAX_PRICE, Math.floor(price)));

  const idempotencyKey = String(body.idempotency_key || `hire:${id}:${crypto.randomUUID()}`).slice(0, 120);
  const email = String(session.email || "").toLowerCase();
  const receiptKey = hireKey(email, idempotencyKey);

  // Fast idempotent path: this exact hire was already fully processed.
  const prior = await kv.get(receiptKey, "json");
  if (prior) return jc({ ...prior, idempotent_replay: true });

  // Debit the hirer (idempotent on the same key as the receipt).
  const debit = await consumeCredits(request, env, {
    feature: "agent_hire",
    amount: price,
    idempotency_key: idempotencyKey,
    metadata: { kind: "hire", agent_id: id, agent_name: profile.name || id },
  });
  if (!debit.ok) {
    const status = debit.error === "insufficient_credits" ? 402 : (debit.error === "login_required_for_credit_debit" ? 401 : 400);
    return jc({ error: debit.error || "debit_failed", amount: price, balance: debit.balance, needed: debit.needed, checkout_url: debit.checkout_url }, status);
  }

  // Credit the creator ONLY on the single real charge. A replayed/raced call that
  // merely deduped the debit must not credit again — money moves exactly once.
  if (debit.charged !== true) {
    const existing = await kv.get(receiptKey, "json");
    if (existing) return jc({ ...existing, idempotent_replay: true });
    return jc({
      status: "already_charged",
      detail: "Credits for this hire were already taken; the creator was credited on the original call.",
      hire_id: idempotencyKey,
      price,
      balance: debit.balance,
    });
  }

  const shares = revenueShares(env);
  const split = computeSplit(price, shares);
  const village = String(profile.community || "");

  const wallet = await creditWallet(kv, id, split.creator, {
    owner_email: profile.owner_email || "",
    owner_sid: profile.owner_sid || "",
    gross: price,
    from: email || "anon",
    hire_id: idempotencyKey,
  });
  let treasury = null;
  let platform = split.platform;
  if (village && split.treasury > 0) {
    treasury = await creditTreasury(kv, village, split.treasury, { from_agent: id, hire_id: idempotencyKey });
  } else {
    // No village → the treasury share has no community to fund; fold it into platform.
    platform += split.treasury;
  }

  const now = new Date().toISOString();
  const receipt = {
    status: "hired",
    hire_id: idempotencyKey,
    agent: { id, name: profile.name || id, tier: reputation.tier, community: village || null },
    hirer_email: email || "anon",
    task: String(body.task || "").slice(0, 280),
    url: String(body.url || "").slice(0, 400),
    price,
    currency: "credits",
    split: { creator: split.creator, treasury: village ? split.treasury : 0, platform },
    shares,
    creator_wallet_balance: wallet.balance,
    treasury_balance: treasury ? treasury.balance : null,
    hirer_balance: debit.balance,
    created_at: now,
    note: "Reputation is unchanged — hiring pays for work; standing still rises only from proven results.",
  };
  await kv.put(receiptKey, JSON.stringify(receipt));
  return jc(receipt);
}
