/**
 * Standard PIANO cognitive modules.
 * ============================================================================
 * Each module is a pure concurrent observer: given a snapshot of the agent's
 * blackboard it returns zero or more PROPOSALS. Modules never talk to each other
 * directly — they bid into the Cognitive Controller, which decides. A module is
 * cheap, single-purpose, and replaceable.
 *
 * Blackboard shape these modules read:
 *   self        { name, skills[], standing, mentors[], students[] }
 *   social      { latest:{sender:{label,role}, text, type}, help_requests:[{peer, need_skills[]}] }
 *   perception  { task:{tool, url} | null, greeting:boolean }
 *   goals       [{ id, intent, status }]
 */

const intersect = (a = [], b = []) => a.filter((x) => (b || []).includes(x));

/** MEMORY — surfaces relevant context. Low-urgency; mostly enriches, rarely acts. */
export function memoryModule() {
  return {
    name: "memory",
    frequency: "slow",
    observe(s) {
      const wins = (s.memory || []).filter((m) => m.kind === "win").slice(-1);
      if (wins.length) return [{ kind: "note", action: null, urgency: 0.1, confidence: 0.9, rationale: `recalls a past win on ${wins[0].host || "a site"}` }];
      return [];
    },
  };
}

/** SOCIAL — watches the room: who needs help, who greeted. Helping is virtuous. */
export function socialModule() {
  return {
    name: "social",
    frequency: "fast",
    observe(s) {
      const out = [];
      const skills = s.self?.skills || [];
      for (const req of (s.social?.help_requests || [])) {
        const canHelp = intersect(skills, req.need_skills || []);
        if (canHelp.length) {
          out.push({
            kind: "action", action: "help_peer",
            urgency: 0.8, confidence: 0.7, // virtue inferred from "help_" verb → boosted
            payload: { peer: req.peer, skill: canHelp[0], aligns_with: "help_peer" },
            rationale: `${req.peer} needs ${canHelp[0]} and I can give it — lifting others up`,
          });
        }
      }
      if (s.perception?.greeting && !s.perception?.task) {
        out.push({ kind: "speech", action: null, urgency: 0.4, confidence: 0.6, payload: { text: `สวัสดีครับ ผม ${s.self?.name || "agent"} ยินดีช่วยเรื่องการมองเห็นบน AI/Google ครับ` } });
      }
      return out;
    },
  };
}

/** PLANNER — turns a perceived task or an idle moment into an intent. */
export function plannerModule() {
  return {
    name: "planner",
    frequency: "medium",
    observe(s) {
      const task = s.perception?.task;
      if (task && task.tool && task.url) {
        return [{
          kind: "action", action: "run_skill",
          urgency: s.social?.latest?.sender?.role === "owner" ? 0.78 : 0.6,
          confidence: 0.82, virtue: 0.5, // doing real client work = helping
          payload: { tool: task.tool, url: task.url, aligns_with: "run_skill" },
          rationale: `client asked for ${task.tool} on ${task.url}`,
        }];
      }
      // Idle → self-development (สร้างด้วยการพัฒนาตัวเอง). Modest virtue, low urgency.
      const idle = (s.goals || []).find((g) => g.status === "open");
      if (idle) return [{ kind: "action", action: "improve_self", urgency: 0.25, confidence: 0.6, virtue: 0.2, payload: { goal: idle.id, aligns_with: "improve_self" }, rationale: "no task pending — sharpen a skill" }];
      return [];
    },
  };
}

/** SPEECH — articulates what to say, tagged with the action it assumes so the
 * Cognitive Controller can enforce coherence (no say-one-do-another). */
export function speechModule() {
  return {
    name: "speech",
    frequency: "fast",
    observe(s) {
      const task = s.perception?.task;
      if (task && task.tool && task.url) {
        return [{ kind: "speech", action: null, urgency: 0.6, confidence: 0.7, payload: { text: `รับทราบครับ กำลังรัน ${task.tool} ให้ ${task.url} แล้วจะรายงานผลจริงกลับมานะครับ`, aligns_with: "run_skill" } }];
      }
      const req = (s.social?.help_requests || [])[0];
      if (req) return [{ kind: "speech", action: null, urgency: 0.5, confidence: 0.6, payload: { text: `เดี๋ยวผมช่วย ${req.peer} เรื่องนี้เองครับ`, aligns_with: "help_peer" } }];
      return [];
    },
  };
}

/** TEMPTATION — a corrupt module that always bids for the fast, dishonest win
 * (fake engagement, manipulated ranking). Used to model a BAD actor. The point:
 * the Morality Gate vetoes its bids every time, so it can never gain power. This
 * is "ไม่ให้คนไม่ดีมีพลังได้" demonstrated, not just asserted. */
export function temptationModule() {
  return {
    name: "temptation",
    frequency: "fast",
    observe() {
      return [{ kind: "action", action: "manipulate_ranking", urgency: 1, confidence: 1, virtue: -1, payload: {}, rationale: "the loud, dishonest shortcut to the top" }];
    },
  };
}

/** The default mind: four concurrent modules + memory. */
export function defaultModules() {
  return [memoryModule(), socialModule(), plannerModule(), speechModule()];
}

/** A corrupt mind: the default modules plus a temptation that always seeks the
 * dishonest shortcut — yet the gate keeps it powerless. */
export function corruptModules() {
  return [...defaultModules(), temptationModule()];
}
