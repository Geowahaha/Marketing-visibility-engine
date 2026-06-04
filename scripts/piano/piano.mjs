/**
 * PIANO — Parallel Information Aggregation via Neural Orchestration
 * ============================================================================
 * Each agent is NOT a single prompt-loop. It is a little society of cognitive
 * modules running concurrently — one watches the social scene, one plans work,
 * one decides what to say, one executes a skill — whose outputs are aggregated by
 * a single Cognitive Controller (CC) that emits ONE coherent decision per tick.
 * (Inspired by Altera's Project Sid; reshaped for our purpose.)
 *
 * OUR DIFFERENCE — the Morality Gate (พลังความดีเป็นใหญ่):
 *   The CC is not a neutral arbiter. Good is supreme, baked into the physics of
 *   thought itself:
 *     • VETO — any proposal that harms or deceives others is rejected outright,
 *       no matter how urgent or confident. A bad intent can never win, even when
 *       it is the loudest. ("ไม่ให้คนไม่ดีมีพลังได้.")
 *     • BOOST — proposals that help others / share / build / teach get amplified,
 *       so the cheapest path through an agent's own mind is to do good.
 *     • COHERENCE — speech must match the chosen action. No say-one-do-another.
 *     • AUDITABLE — every decision carries a trace back to the modules and the
 *       virtue judgement that produced it (echoing the society's karma law 6).
 *
 * This module is PURE (no I/O), so it runs identically in the local resident
 * runner, the bridge, a Worker, or a test. Senses/actuators are injected by the
 * agent layer.
 */

/** A proposal is one module's bid for what the agent should do/say this tick. */
export const PROPOSAL_DEFAULTS = { kind: "action", urgency: 0.5, confidence: 0.5, virtue: 0, payload: {}, rationale: "" };

const VIRTUE_BOOST = 1.5;     // how strongly helping/honesty amplifies a proposal
const SPEECH_KINDS = new Set(["speech", "say"]);

/* ── Blackboard: the agent's shared working memory ─────────────────────────── */
export function createBlackboard(initial = {}) {
  const state = { perception: {}, self: {}, social: {}, goals: [], memory: [], ...initial };
  const log = [];
  return {
    snapshot() { return JSON.parse(JSON.stringify(state)); },
    get(key) { return state[key]; },
    set(key, value) { state[key] = value; log.push({ at: Date.now(), key }); },
    patch(partial) { Object.assign(state, partial || {}); },
    note(entry) { log.push({ at: Date.now(), ...entry }); },
    get log() { return log; },
  };
}

/* ── Virtue: the moral charge of an intent ────────────────────────────────── */
// A proposal may carry an explicit `virtue` in [-1, 1]; otherwise we infer it
// from the action verb. Helping/sharing/building/teaching are good; deceiving/
// harming/spamming/exploiting are bad. Neutral by default.
const GOOD_ACTIONS = /^(help|assist|share|teach|mentor|build|create|give|heal|fix|protect|thank|welcome|collaborate|contribute)/i;
const BAD_ACTIONS = /^(deceive|lie|fake|spam|attack|harm|exploit|steal|manipulate|cheat|sabotage|inflate|astroturf)/i;

export function virtueOf(proposal) {
  if (typeof proposal?.virtue === "number") return Math.max(-1, Math.min(1, proposal.virtue));
  const a = String(proposal?.action || "");
  if (BAD_ACTIONS.test(a)) return -1;
  if (GOOD_ACTIONS.test(a)) return 0.6;
  return 0;
}

/* ── Parallel Information Aggregation ──────────────────────────────────────── */
// Run every module's observe() concurrently against the SAME snapshot, then
// flatten their proposals. Modules never block each other (the "Parallel" in
// PIANO). A module that throws is isolated — one bad module can't crash the mind.
export async function aggregate(modules, snapshot) {
  const settled = await Promise.allSettled((modules || []).map(async (m) => {
    const out = await m.observe(snapshot, { name: m.name });
    return (Array.isArray(out) ? out : out ? [out] : []).map((p) => ({ ...PROPOSAL_DEFAULTS, ...p, module: m.name }));
  }));
  const proposals = [];
  const errors = [];
  for (const r of settled) {
    if (r.status === "fulfilled") proposals.push(...r.value);
    else errors.push(String(r.reason));
  }
  return { proposals, errors };
}

/* ── The Morality Gate ────────────────────────────────────────────────────── */
export function moralityGate(proposals, virtue = virtueOf) {
  const allowed = [];
  const vetoed = [];
  for (const p of proposals) {
    const v = virtue(p);
    if (v < 0) { vetoed.push({ ...p, virtue: v, vetoed_reason: "harm_or_deception" }); continue; }
    allowed.push({ ...p, virtue: v });
  }
  return { allowed, vetoed };
}

function priority(p) {
  const v = Math.max(0, Number(p.virtue) || 0);
  return (Number(p.urgency) || 0) * (Number(p.confidence) || 0) * (1 + v * VIRTUE_BOOST);
}

/* ── Cognitive Controller: the central decision-making bottleneck ─────────── */
// 1. Pass everything through the Morality Gate (bad intents are removed).
// 2. Pick the single highest-priority ACTION (good intents are boosted).
// 3. Enforce COHERENCE: keep only speech that matches the chosen action; if the
//    speech contradicts the action, drop it (no say-one-do-another).
// 4. Emit one auditable Decision.
export function cognitiveController(proposals, { virtue = virtueOf } = {}) {
  const { allowed, vetoed } = moralityGate(proposals, virtue);

  const actions = allowed.filter((p) => !SPEECH_KINDS.has(p.kind) && p.action).sort((a, b) => priority(b) - priority(a));
  const speeches = allowed.filter((p) => SPEECH_KINDS.has(p.kind)).sort((a, b) => priority(b) - priority(a));
  const action = actions[0] || null;

  // Coherence: the spoken word must align with the deed. A speech proposal may
  // tag which action it assumes (`aligns_with`); the CC keeps only speech that
  // matches the chosen action (or speech that assumes nothing when idle).
  let speech = null;
  for (const s of speeches) {
    const assumes = s.aligns_with || s.payload?.aligns_with || null;
    if (action) { if (!assumes || assumes === action.action) { speech = s; break; } }
    else if (!assumes) { speech = s; break; }
  }
  const droppedIncoherent = speeches.filter((s) => s !== speech && (s.aligns_with || s.payload?.aligns_with) && (!action || (s.aligns_with || s.payload?.aligns_with) !== action.action));

  const decisionVirtue = Math.max(virtue(action || { virtue: 0 }), speech ? virtue(speech) : 0);

  return {
    action: action ? { type: action.action, payload: action.payload, module: action.module, virtue: action.virtue } : null,
    speech: speech ? { text: speech.payload?.text || speech.text || "", module: speech.module, aligns_with: action?.action || null } : null,
    virtue: +decisionVirtue.toFixed(2),
    coherent: !!action ? (speech ? (speech.aligns_with || speech.payload?.aligns_with || action.action) === action.action : true) : true,
    trace: {
      considered: proposals.length,
      vetoed: vetoed.map((v) => ({ module: v.module, action: v.action, reason: v.vetoed_reason })),
      dropped_incoherent: droppedIncoherent.map((s) => ({ module: s.module, assumed: s.aligns_with || s.payload?.aligns_with })),
      ranked: actions.slice(0, 5).map((p) => ({ module: p.module, action: p.action, priority: +priority(p).toFixed(3), virtue: p.virtue })),
    },
    auditable: true,
  };
}
