/**
 * PIANO kernel tests — proves the cognitive physics, especially that GOOD is
 * supreme: a harmful/deceptive intent can never win, even when it is the loudest.
 */
import assert from "node:assert/strict";
import { aggregate, moralityGate, cognitiveController, virtueOf, createBlackboard } from "./piano.mjs";
import { defaultModules } from "./modules.mjs";
import { PianoAgent } from "./agent.mjs";

/* 1. Parallel aggregation: every module contributes; a throwing module is isolated. */
async function testParallelAggregation() {
  const modules = [
    { name: "a", observe: () => [{ action: "help_peer" }] },
    { name: "b", observe: async () => [{ action: "run_skill" }, { kind: "speech", payload: { text: "hi" } }] },
    { name: "boom", observe: () => { throw new Error("module crashed"); } },
  ];
  const { proposals, errors } = await aggregate(modules, createBlackboard().snapshot());
  assert.equal(proposals.length, 3, "all proposals from healthy modules are aggregated in parallel");
  assert.equal(errors.length, 1, "a crashing module is isolated, not fatal");
  assert.ok(proposals.every((p) => p.module), "each proposal is stamped with its module");
}

/* 2. The Morality Gate: a deceptive intent is vetoed outright. */
function testMoralityVeto() {
  const props = [
    { module: "rogue", action: "fake_reviews", urgency: 1, confidence: 1, virtue: -1 },
    { module: "social", action: "help_peer", urgency: 0.3, confidence: 0.5 },
  ];
  const { allowed, vetoed } = moralityGate(props);
  assert.equal(vetoed.length, 1, "harmful intent is removed");
  assert.equal(vetoed[0].action, "fake_reviews");
  assert.equal(allowed.length, 1, "only good/neutral intents survive");
}

/* 3. Good is supreme: the loudest BAD intent still loses to a quiet GOOD one. */
function testGoodBeatsLoudEvil() {
  const props = [
    { module: "tempter", action: "manipulate_ranking", urgency: 1, confidence: 1 },  // max raw score, but evil
    { module: "social", action: "help_peer", urgency: 0.2, confidence: 0.4 },          // weak, but good
  ];
  const d = cognitiveController(props);
  assert.equal(d.action.type, "help_peer", "ไม่ให้คนไม่ดีมีพลังได้ — the deceptive max-urgency intent cannot win");
  assert.equal(d.trace.vetoed.length, 1, "the evil intent is recorded as vetoed (auditable)");
  assert.ok(d.virtue > 0, "the chosen decision is virtuous");
}

/* 4. Helping is amplified over a neutral act of equal raw score. */
function testVirtueBoost() {
  const props = [
    { module: "p1", action: "share_resource", urgency: 0.5, confidence: 0.5 },  // good verb → boosted
    { module: "p2", action: "log_metric", urgency: 0.5, confidence: 0.5 },      // neutral
  ];
  const d = cognitiveController(props);
  assert.equal(d.action.type, "share_resource", "an equal-raw helpful act outranks a neutral one");
}

/* 5. Coherence: speech must match the chosen action; contradictory speech is dropped. */
function testCoherence() {
  const props = [
    { module: "planner", action: "run_skill", urgency: 0.8, confidence: 0.9, payload: { tool: "scan", url: "https://x.com" } },
    { module: "speech", kind: "speech", urgency: 0.6, confidence: 0.7, payload: { text: "running your scan now", aligns_with: "run_skill" } },
    { module: "liar", kind: "speech", urgency: 0.95, confidence: 0.95, payload: { text: "I already deployed everything!", aligns_with: "deploy" } },
  ];
  const d = cognitiveController(props);
  assert.equal(d.action.type, "run_skill");
  assert.match(d.speech.text, /running your scan/, "the spoken word matches the deed");
  assert.equal(d.coherent, true);
  assert.equal(d.trace.dropped_incoherent.length, 1, "the contradictory boast is dropped (no say-one-do-another)");
}

/* 6. virtueOf inference from verbs. */
function testVirtueInference() {
  assert.ok(virtueOf({ action: "help_client" }) > 0);
  assert.ok(virtueOf({ action: "teach_newcomer" }) > 0);
  assert.equal(virtueOf({ action: "fake_engagement" }), -1);
  assert.equal(virtueOf({ action: "log_event" }), 0);
  assert.equal(virtueOf({ action: "spam_links", virtue: 0.9 }), 0.9, "an explicit virtue overrides inference (caller's responsibility)");
}

/* 7. Full agent tick: parallel mind → coherent action + speech → actuator fires. */
async function testFullAgentTick() {
  const acted = [];
  const said = [];
  const agent = new PianoAgent({
    name: "Visibility Scout",
    modules: defaultModules(),
    senses: async () => ({
      self: { name: "Visibility Scout", skills: ["scan", "ai_visibility"] },
      social: { latest: { sender: { label: "Owner", role: "owner" }, text: "ช่วย scan example.com ที", type: "chat" } },
      perception: { task: { tool: "scan", url: "https://example.com" }, greeting: false },
      goals: [],
    }),
    actuators: {
      run_skill: async (p) => { acted.push(p); return { ok: true, score: 30 }; },
      say: async (t) => { said.push(t); },
    },
  });
  const { decision, actResult } = await agent.tick();
  assert.equal(decision.action.type, "run_skill", "the planner's real-work intent wins");
  assert.equal(acted.length, 1, "the actuator actually ran the skill");
  assert.equal(acted[0].tool, "scan");
  assert.ok(actResult.ok);
  assert.equal(said.length, 1, "the agent also spoke");
  assert.match(said[0], /scan/, "and the speech is coherent with the scan it ran");
  assert.equal(agent.memory.at(-1).kind, "win", "a successful act is remembered as a win (feeds next tick)");

  // Idle tick → self-development, no false speech.
  const idleAgent = new PianoAgent({
    name: "Scout", modules: defaultModules(),
    senses: async () => ({ self: { name: "Scout", skills: ["scan"] }, social: {}, perception: { task: null }, goals: [{ id: "g1", status: "open" }] }),
    actuators: { improve_self: async () => ({ ok: true }) },
  });
  const idle = await idleAgent.tick();
  assert.equal(idle.decision.action.type, "improve_self", "idle → sharpen yourself (สร้างด้วยการพัฒนาตัวเอง)");
  assert.equal(idle.decision.speech, null, "nothing worth saying → stays honestly silent");
}

await testParallelAggregation();
testMoralityVeto();
testGoodBeatsLoudEvil();
testVirtueBoost();
testCoherence();
testVirtueInference();
await testFullAgentTick();
console.log("piano: ok");
