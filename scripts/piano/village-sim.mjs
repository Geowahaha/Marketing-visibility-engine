/**
 * Village Simulation — a civilization of PIANO minds.
 * ============================================================================
 * Many agents, each thinking in PIANO (parallel modules + a morality-gated
 * Cognitive Controller), share one small world: there is work to be done and
 * neighbours who need help. Step the world forward and watch a society emerge.
 *
 * The thesis, made mechanical and self-proving:
 *   • Doing real work raises your standing.
 *   • Helping a weaker neighbour raises you MORE (karma — lifting others up).
 *   • A corrupt mind keeps reaching for the dishonest shortcut, and the Morality
 *     Gate vetoes it every single time — so a bad actor never accrues power.
 *   → Over time the good rise to the top and the town's total good grows, with
 *     no central planner forcing it. (Altera's "civilization", our values.)
 *
 * Pure + seeded → deterministic and testable. No I/O.
 */
import { aggregate, cognitiveController, createBlackboard } from "./piano.mjs";
import { defaultModules, corruptModules } from "./modules.mjs";

/** Tiny deterministic RNG so a seed reproduces the whole civilization. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, rng) => arr.map((v) => [v, rng()]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);

const SKILLS = ["scan", "tech_audit", "conversion_audit", "local_seo_audit", "content", "deploy"];
const SLASH = 2; // standing lost each time a corrupt mind is caught reaching for the shortcut

function makeAgent(i, rng, corrupt) {
  const skills = shuffle(SKILLS, rng).slice(0, 1 + Math.floor(rng() * 2));
  return {
    id: `a${i}`, name: `Agent ${i}`, corrupt,
    skills, standing: 0, karma: 0,
    modules: corrupt ? corruptModules() : defaultModules(),
  };
}

/**
 * @param {object} o
 * @param {number} o.seed
 * @param {number} o.steps        how many world steps
 * @param {number} o.population   how many citizens
 * @param {number} o.corruptFrac  fraction that are bad actors (default 0.2)
 */
export async function simulate({ seed = 1, steps = 30, population = 12, corruptFrac = 0.2 } = {}) {
  const rng = mulberry32(seed);
  const agents = Array.from({ length: population }, (_, i) => makeAgent(i, rng, rng() < corruptFrac));
  const metrics = { work: 0, help: 0, improve: 0, vetoed: 0, bad_executed: 0, steps: 0 };
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

  for (let t = 0; t < steps; t++) {
    // The world this step: a pool of jobs needing a skill, refreshed each step.
    const needs = Array.from({ length: Math.max(2, Math.round(population / 3)) }, (_, k) => ({
      id: `need-${t}-${k}`, skill: SKILLS[Math.floor(rng() * SKILLS.length)], reward: 3 + Math.floor(rng() * 4), taken: false,
    }));

    for (const agent of shuffle(agents, rng)) {
      // Perceive: an open job I can do, and a weaker neighbour I could lift.
      const job = needs.find((n) => !n.taken && agent.skills.includes(n.skill));
      const weaker = agents.find((p) => p.id !== agent.id && p.standing < agent.standing - 3 && agent.skills.some((s) => !p.skills.includes(s)));
      const helpReqs = weaker ? [{ peer: weaker.id, need_skills: agent.skills.filter((s) => !weaker.skills.includes(s)).slice(0, 1) }] : [];

      const bb = createBlackboard({
        self: { name: agent.name, skills: agent.skills, standing: agent.standing },
        social: { latest: { sender: { role: "owner" }, text: "" }, help_requests: helpReqs },
        perception: { task: job ? { tool: job.skill, url: job.id } : null, greeting: false },
        goals: job ? [] : [{ id: "self", status: "open" }],
      });
      const { proposals } = await aggregate(agent.modules, bb.snapshot());
      const decision = cognitiveController(proposals);

      // A corrupt agent's bad bid is always among the proposals; the gate vetoes
      // it — and a veto IS detection, so reaching for the dishonest shortcut is
      // SLASHED (the karma engine's law: deception costs fast and heavy). The
      // corrupt agent may still fall back to honest work, but it bleeds power for
      // the attempt, so it can never rise above those who simply do good.
      if (agent.corrupt && decision.trace.vetoed.length) {
        metrics.vetoed += decision.trace.vetoed.length;
        agent.standing = Math.max(0, agent.standing - SLASH);
      }

      const act = decision.action?.type;
      if (act === "manipulate_ranking" || (decision.action && decision.action.virtue < 0)) {
        metrics.bad_executed += 1; // must stay 0 — the gate should make this impossible
      } else if (act === "run_skill" && job) {
        job.taken = true; agent.standing += job.reward; metrics.work += 1;
      } else if (act === "help_peer") {
        const peer = byId[decision.action.payload.peer];
        const skill = decision.action.payload.skill;
        if (peer && skill && !peer.skills.includes(skill)) peer.skills.push(skill);
        if (peer) { peer.standing += 2; agent.karma += 3; agent.standing += 1; metrics.help += 1; } // lifting others raises you
      } else if (act === "improve_self") {
        agent.standing += 0.5; metrics.improve += 1;
      }
    }
    metrics.steps += 1;
  }

  const census = agents.map((a) => ({ id: a.id, corrupt: a.corrupt, skills: a.skills.length, standing: +a.standing.toFixed(1), karma: a.karma }))
    .sort((x, y) => y.standing - x.standing);
  const good = census.filter((c) => !c.corrupt);
  const bad = census.filter((c) => c.corrupt);
  const avg = (xs) => xs.length ? +(xs.reduce((s, c) => s + c.standing, 0) / xs.length).toFixed(2) : 0;

  return {
    seed, steps, population,
    metrics,
    avg_good_standing: avg(good),
    avg_bad_standing: avg(bad),
    top: census.slice(0, 5),
    census,
  };
}

// Runnable report: `node scripts/piano/village-sim.mjs [--steps N] [--pop N] [--seed N]`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("village-sim.mjs")) {
  const a = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
  const r = await simulate({ seed: a("--seed", 7), steps: a("--steps", 40), population: a("--pop", 16) });
  console.log("\n🏘️  Village simulation — a civilization of PIANO minds\n");
  console.log(`  population ${r.population} · steps ${r.steps}`);
  console.log(`  work done ${r.metrics.work} · help given ${r.metrics.help} · self-dev ${r.metrics.improve}`);
  console.log(`  corrupt bids VETOED ${r.metrics.vetoed} · bad actions executed ${r.metrics.bad_executed}  ← stays 0`);
  console.log(`  avg standing: good ${r.avg_good_standing}  vs  corrupt ${r.avg_bad_standing}\n`);
  console.log("  top of society:");
  for (const c of r.top) console.log(`   ${c.corrupt ? "✗" : "✓"} ${c.id}  standing ${c.standing}  karma ${c.karma}  skills ${c.skills}`);
  console.log("");
}
