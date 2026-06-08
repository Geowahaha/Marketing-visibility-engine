/**
 * AI Mark — Visibility Intelligence (the data moat).
 * ------------------------------------------------------------------
 * The audit/score time-series in D1 compounds into something worth far more than
 * a scanner: a cross-industry **Visibility Intelligence Dataset**. This module
 * turns the accumulating `audits`/`sites` data into BENCHMARK intelligence —
 * "you're in the bottom 20% of your industry for AI visibility" — which is the
 * mid-term product ("sell Intelligence"), strengthens every sales pitch, and gets
 * better automatically with every scan (data network effect).
 *
 * Privacy invariant: benchmarks are computed across ALL tenants but expose ONLY
 * aggregate numbers (count / average / percentile). No other tenant's identity,
 * URL, or row is ever returned. The moat is the aggregate, not anyone's private data.
 */
import { db, dbReady, ensureSchema } from "./_db.js";

export function median(nums) {
  const s = (nums || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Percentile = % of the cohort this value OUTPERFORMS (strictly below it), so the
 *  weakest site reads 0 ("bottom") — the sharpest, most honest sales hook. */
export function percentileRank(value, scores) {
  const arr = (scores || []).filter((n) => Number.isFinite(n));
  if (!arr.length || !Number.isFinite(value)) return null;
  return Math.round((arr.filter((s) => s < value).length / arr.length) * 100);
}

export function cohortStats(scores) {
  const arr = (scores || []).filter((n) => Number.isFinite(n));
  if (!arr.length) return { count: 0, avg: null, median: null, min: null, max: null };
  return {
    count: arr.length,
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
    median: median(arr),
    min: Math.min(...arr),
    max: Math.max(...arr),
  };
}

/** Confidence in a benchmark grows with cohort size (honest about thin data). */
export function benchmarkConfidence(count) {
  return count >= 8 ? "good" : count >= 3 ? "limited" : "insufficient";
}

export function positionLabel(percentile) {
  if (percentile == null) return "unknown";
  if (percentile >= 80) return "top";
  if (percentile <= 20) return "bottom";
  return "middle";
}

/** All latest scores in an industry, across ALL tenants (anonymized — scores only). */
export async function cohortScores(env, industry) {
  if (!dbReady(env) || !industry) return [];
  await ensureSchema(env);
  const r = await db(env).prepare(
    "SELECT latest_score FROM sites WHERE industry = ? AND latest_score IS NOT NULL"
  ).bind(String(industry)).all();
  return ((r && r.results) || []).map((x) => Number(x.latest_score)).filter(Number.isFinite);
}

/** Industries with enough data to benchmark (for discovery / coverage of the dataset). */
export async function coveredIndustries(env, minCount = 1) {
  if (!dbReady(env)) return [];
  await ensureSchema(env);
  const r = await db(env).prepare(
    "SELECT industry, COUNT(*) AS n, AVG(latest_score) AS avg FROM sites WHERE industry IS NOT NULL AND latest_score IS NOT NULL GROUP BY industry HAVING n >= ? ORDER BY n DESC LIMIT 50"
  ).bind(minCount).all();
  return ((r && r.results) || []).map((x) => ({ industry: x.industry, count: Number(x.n), avg: x.avg == null ? null : Math.round(Number(x.avg)) }));
}

/** Build the benchmark intelligence for one site within its industry cohort. */
export async function siteBenchmark(env, site) {
  const industry = site && site.industry;
  if (!industry) return { available: false, reason: "no_industry" };
  const scores = await cohortScores(env, industry);
  const stats = cohortStats(scores);
  const yourScore = site.latest_score == null ? null : Number(site.latest_score);
  const percentile = percentileRank(yourScore, scores);
  return {
    available: true,
    industry,
    your_score: yourScore,
    cohort: stats,
    your_percentile: percentile,
    position: positionLabel(percentile),
    confidence: benchmarkConfidence(stats.count),
    gap_to_top: (yourScore != null && stats.max != null) ? Math.max(0, stats.max - yourScore) : null,
    gap_to_avg: (yourScore != null && stats.avg != null) ? stats.avg - yourScore : null,
  };
}
