/**
 * AI Mark — Economy Layer (L7): the agent economy.
 * ------------------------------------------------------------------
 * The keystone that connects the two halves we already had:
 *   - the BUYER side (_credits.js): humans buy credits and spend them.
 *   - the REPUTATION side (_agents_registry.js): an agent's proof-backed
 *     `suggested_credits` (its earned "ค่าตัว").
 *
 * A HIRE is the transaction that makes "ค่าตัว" real: the hirer's credits are
 * debited (via the existing _credits ledger) and SPLIT three ways —
 *
 *   creator  → the agent owner's wallet   (Creator Revenue — the north star)
 *   treasury → the village's treasury      (community prosperity / L11)
 *   platform → keeps the lights on         (sustainability)
 *
 * Every hire is an auditable event (law 6: every credit traces back to a hire),
 * so the economy is as transparent as the karma engine.
 *
 * Design invariants:
 *   - Reputation (standing) is NEVER moved by money. Being hired is not the same
 *     as doing good work — standing rises only from proof. Earning and standing
 *     are orthogonal dimensions (money ≠ merit). This keeps the moat honest.
 *   - Wallet/treasury/hire records live in agentKv (with the agent profiles),
 *     while the credit debit lives in ENTITLEMENTS_KV (the buyer ledger). Same
 *     separation the rest of the codebase already uses.
 *   - O(1) KV ops per hire → scales to 100k agents / 1000 villages.
 */

export const walletKey = (id) => `agent_wallet:${id}`;
export const treasuryKey = (vid) => `village_treasury:${vid}`;
export const econLedgerKey = (id) => `econ:ledger:${id}`;
export const treasuryLedgerKey = (vid) => `econ:treasury:${vid}`;

export function safeEconKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9@._:/|-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 200);
}

export const hireKey = (email, idempotencyKey) =>
  `econ:hire:${safeEconKey(email || "anon")}:${safeEconKey(idempotencyKey)}`;

/**
 * Revenue split, configurable via env with honest defaults.
 *   AIMARK_CREATOR_SHARE  (default 0.70)
 *   AIMARK_TREASURY_SHARE (default 0.20)
 *   platform = 1 - creator - treasury  (default 0.10)
 */
export function revenueShares(env = {}) {
  let creator = Number(env.AIMARK_CREATOR_SHARE);
  let treasury = Number(env.AIMARK_TREASURY_SHARE);
  if (!Number.isFinite(creator) || creator < 0) creator = 0.7;
  if (!Number.isFinite(treasury) || treasury < 0) treasury = 0.2;
  creator = Math.min(1, creator);
  treasury = Math.min(1 - creator, treasury); // creator + treasury can never exceed 1
  const platform = +(1 - creator - treasury).toFixed(6);
  return { creator, treasury, platform };
}

/**
 * Split an integer credit amount three ways with EXACT conservation: the parts
 * always sum back to `amount` (the platform part absorbs rounding remainder).
 * Pure — the heart of the economy, fully unit-tested.
 */
export function computeSplit(amount, shares) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  const s = shares || revenueShares();
  const creator = Math.min(amt, Math.floor(amt * s.creator));
  const treasury = Math.min(amt - creator, Math.floor(amt * s.treasury));
  const platform = amt - creator - treasury; // remainder → never negative, sum is exact
  return { total: amt, creator, treasury, platform };
}

/** Read an agent's earnings wallet (zero-state if none yet). */
export async function readWallet(kv, agentId) {
  const w = (await kv.get(walletKey(agentId), "json")) || null;
  return w || { agent_id: agentId, balance: 0, lifetime_earned: 0, currency: "credits", hires: 0, updated_at: "" };
}

/** Read a village treasury (zero-state if none yet). */
export async function readTreasury(kv, villageId) {
  const t = (await kv.get(treasuryKey(villageId), "json")) || null;
  return t || { village: villageId, balance: 0, lifetime_in: 0, lifetime_out: 0, currency: "credits", updated_at: "" };
}

/** Credit an agent's wallet (creator revenue). Best-effort; returns the new wallet. */
export async function creditWallet(kv, agentId, amount, meta = {}) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  const now = new Date().toISOString();
  const w = await readWallet(kv, agentId);
  const next = {
    agent_id: agentId,
    owner_email: meta.owner_email || w.owner_email || "",
    owner_sid: meta.owner_sid || w.owner_sid || "",
    balance: Math.max(0, Number(w.balance || 0)) + amt,
    lifetime_earned: Math.max(0, Number(w.lifetime_earned || 0)) + amt,
    hires: Math.max(0, Number(w.hires || 0)) + (amt > 0 ? 1 : 0),
    currency: "credits",
    updated_at: now,
  };
  await kv.put(walletKey(agentId), JSON.stringify(next));
  // Auditable per-agent earnings ledger (law 6).
  if (amt > 0) {
    const ledger = (await kv.get(econLedgerKey(agentId), "json")) || [];
    const entry = { at: now, kind: "earning", net: amt, gross: meta.gross || amt, from: meta.from || "", hire_id: meta.hire_id || "" };
    await kv.put(econLedgerKey(agentId), JSON.stringify((Array.isArray(ledger) ? ledger : []).concat([entry]).slice(-50)));
  }
  return next;
}

/** Credit a village treasury (community fund). Best-effort; returns the new treasury. */
export async function creditTreasury(kv, villageId, amount, meta = {}) {
  if (!villageId) return null;
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  const now = new Date().toISOString();
  const t = await readTreasury(kv, villageId);
  const next = {
    village: villageId,
    balance: Math.max(0, Number(t.balance || 0)) + amt,
    lifetime_in: Math.max(0, Number(t.lifetime_in || 0)) + amt,
    lifetime_out: Math.max(0, Number(t.lifetime_out || 0)),
    currency: "credits",
    updated_at: now,
  };
  await kv.put(treasuryKey(villageId), JSON.stringify(next));
  if (amt > 0) {
    const ledger = (await kv.get(treasuryLedgerKey(villageId), "json")) || [];
    const entry = { at: now, kind: "treasury_in", amount: amt, from_agent: meta.from_agent || "", hire_id: meta.hire_id || "" };
    await kv.put(treasuryLedgerKey(villageId), JSON.stringify((Array.isArray(ledger) ? ledger : []).concat([entry]).slice(-50)));
  }
  return next;
}
