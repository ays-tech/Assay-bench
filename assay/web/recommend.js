/**
 * The decision rule. Pure, and deliberately conservative: it recommends a switch only when the
 * evidence supports it, and says how much more evidence would settle the question when it does not.
 *
 * Non-inferiority: a cheaper model is "equivalent" when the LOWER end of the 95 % interval on
 * (candidate − current) accuracy is no worse than -margin. The point estimate alone is never enough.
 */

export const DEFAULTS = { marginPts: 5, minSamples: 20, minSavings: 0.1, maxNeededSamples: 2000 };

/**
 * Turn a stored benchmark report's models into the shape `recommend` expects, so the dashboard
 * can re-run the decision at a different margin without another benchmark.
 * @param {Array<any>} reportModels
 * @returns {ModelStats[]}
 */
export function statsFromReport(reportModels) {
  return reportModels.map((m) => ({
    id: m.id, isCurrent: m.role === 'current', costPer1k: m.costPer1kUsd, n: m.n, accuracy: m.accuracy,
    diff: m.diff ?? null, diffSd: m.diffSd ?? null, costPerCorrect: m.costPerCorrect1kUsd ?? null, errorRate: m.errorRate ?? 0,
  }));
}

/**
 * @typedef {object} ModelStats
 * @property {string} id
 * @property {boolean} isCurrent
 * @property {number} costPer1k        USD per 1,000 calls at catalog price
 * @property {number} n                prompts scored
 * @property {number} accuracy         0–1
 * @property {{est:number, lo:number, hi:number}|null} diff    candidate − current, fraction of prompts
 * @property {number|null} diffSd
 * @property {number|null} costPerCorrect
 * @property {number} errorRate        share of calls that returned no answer
 */

/**
 * Samples needed for the interval's lower bound to clear the margin, assuming the observed
 * effect and spread hold. Null when the observed effect is already worse than the margin, or
 * the requirement is unrealistic.
 * @param {{est:number}} diff @param {number|null} sd @param {number} margin fraction @param {number} max
 */
export function samplesNeeded(diff, sd, margin, max = DEFAULTS.maxNeededSamples) {
  if (sd === null || !Number.isFinite(sd) || diff.est <= -margin) return null;
  const headroom = margin + diff.est; // distance between the point estimate and the margin
  if (headroom <= 0) return null;
  const n = Math.ceil(((1.96 * sd) / headroom) ** 2);
  return n > max ? null : n;
}

/**
 * @param {ModelStats[]} models current model first
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function recommend(models, options = {}) {
  const { marginPts, minSamples, minSavings, maxNeededSamples } = { ...DEFAULTS, ...options };
  const margin = marginPts / 100;
  const current = models.find((m) => m.isCurrent);
  if (!current) throw new Error('recommend() needs the current model');

  const perModel = {};
  for (const m of models.filter((x) => !x.isCurrent)) {
    const savings = current.costPer1k > 0 ? 1 - m.costPer1k / current.costPer1k : 0;
    let verdict;
    let needed = null;
    if (m.errorRate > 0.3) verdict = 'unreliable';
    else if (m.n < minSamples || !m.diff) verdict = 'insufficient';
    else if (m.diff.lo >= -margin) verdict = 'equivalent';
    else if (m.diff.hi < -margin) verdict = 'worse';
    else {
      verdict = 'inconclusive';
      needed = samplesNeeded(m.diff, m.diffSd, margin, maxNeededSamples);
    }
    perModel[m.id] = { verdict, savings, neededSamples: needed };
  }

  const equivalent = models
    .filter((m) => !m.isCurrent && perModel[m.id].verdict === 'equivalent' && perModel[m.id].savings >= minSavings)
    .sort((a, b) => (a.costPerCorrect ?? Infinity) - (b.costPerCorrect ?? Infinity) || b.accuracy - a.accuracy);

  if (equivalent.length) {
    const best = equivalent[0];
    return { action: /** @type {const} */ ('switch'), model: best.id, savings: perModel[best.id].savings, perModel, marginPts };
  }

  // Not proven, but promising: cheaper and not obviously worse.
  const promising = models
    .filter((m) => !m.isCurrent && ['inconclusive', 'insufficient'].includes(perModel[m.id].verdict) && perModel[m.id].savings >= minSavings && (!m.diff || m.diff.est > -margin))
    .sort((a, b) => (b.diff?.est ?? 0) - (a.diff?.est ?? 0) || perModel[b.id].savings - perModel[a.id].savings);
  if (promising.length) {
    const best = promising[0];
    const p = perModel[best.id];
    return { action: /** @type {const} */ ('need-more-data'), model: best.id, savings: p.savings, neededSamples: p.neededSamples, currentN: best.n, perModel, marginPts };
  }

  return { action: /** @type {const} */ ('keep'), model: current.id, savings: 0, perModel, marginPts };
}

const pct = (x, dp = 0) => `${(x * 100).toFixed(dp)}%`;

/**
 * Plain-language verdict for the dashboard and terminal.
 * @param {ReturnType<typeof recommend>} rec
 * @param {ModelStats[]} models
 */
export function describe(rec, models) {
  const current = models.find((m) => m.isCurrent);
  const chosen = models.find((m) => m.id === rec.model);
  const short = (id) => id.split('/').pop();
  switch (rec.action) {
    case 'switch':
      return {
        headline: `Switch to ${short(rec.model)}: ${pct(rec.savings)} cheaper with equivalent quality.`,
        detail: `On ${chosen.n} of your prompts it scored ${pct(chosen.accuracy)} against ${pct(current.accuracy)} for ${short(current.id)}. Even at the pessimistic end of the 95% interval it is within ${rec.marginPts} points of the current model.`,
      };
    case 'need-more-data':
      return {
        headline: `${short(rec.model)} looks promising, but ${rec.currentN} prompts cannot prove it.`,
        detail: rec.neededSamples
          ? `It is ${pct(rec.savings)} cheaper and not visibly worse, yet the uncertainty still allows a real quality loss. If the pattern holds, about ${rec.neededSamples} prompts would settle it. Add more to your dataset and run again.`
          : `It is ${pct(rec.savings)} cheaper and not visibly worse, but the uncertainty still allows a real quality loss. Add more prompts, especially the hard ones, and run again.`,
      };
    default:
      return {
        headline: `Keep ${short(current.id)}. No cheaper model matched it.`,
        detail: 'Every cheaper candidate was measurably worse, or too unreliable to recommend. That is a real result: the expensive model is earning its price on this workload.',
      };
  }
}
