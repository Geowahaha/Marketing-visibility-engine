/**
 * PianoAgent — wires the PIANO kernel to the outside world.
 * ============================================================================
 * The cognition (piano.mjs) is pure. This class connects it to I/O via two
 * injected adapters, so the SAME mind runs in a live session, the bridge, a
 * Worker, or a test:
 *
 *   senses()           → returns a partial blackboard (what the agent perceives now)
 *   actuators = {       → how the chosen decision touches the world
 *     run_skill(payload), help_peer(payload), improve_self(payload), say(text), ...
 *   }
 *
 * One tick = perceive → think in parallel → the Cognitive Controller decides →
 * act + speak coherently → remember. Every tick returns an auditable decision.
 */
import { createBlackboard, aggregate, cognitiveController, virtueOf } from "./piano.mjs";

export class PianoAgent {
  constructor({ name, modules, senses, actuators = {}, virtue = virtueOf }) {
    this.name = name || "agent";
    this.modules = modules || [];
    this.senses = senses || (async () => ({}));
    this.actuators = actuators;
    this.virtue = virtue;
    this.memory = [];
    this.ticks = 0;
  }

  async tick() {
    this.ticks += 1;
    const perceived = await this.senses();
    const bb = createBlackboard({ ...perceived, memory: this.memory });
    const { proposals, errors } = await aggregate(this.modules, bb.snapshot());
    const decision = cognitiveController(proposals, { virtue: this.virtue });
    decision.module_errors = errors;

    // Act first, then speak — and the speech is the one the CC already proved
    // coherent with the action (or null). The world only ever sees consistency.
    let actResult = null;
    if (decision.action) {
      const fn = this.actuators[decision.action.type];
      if (typeof fn === "function") {
        try { actResult = await fn(decision.action.payload, decision); }
        catch (e) { actResult = { ok: false, error: String(e) }; }
      }
    }
    if (decision.speech && typeof this.actuators.say === "function") {
      try { await this.actuators.say(decision.speech.text, decision); } catch { /* speech is best-effort */ }
    }

    // Remember what happened (feeds the memory module next tick).
    this.memory.push({ at: Date.now(), kind: actResult?.ok ? "win" : "act", action: decision.action?.type || "idle", host: decision.action?.payload?.url });
    this.memory = this.memory.slice(-50);

    return { decision, actResult };
  }
}
