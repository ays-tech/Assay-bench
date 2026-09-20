/** Small, dependency-free statistics helpers. */

/** @param {number[]} xs */
export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

/**
 * Linear-interpolated percentile, p in [0, 100].
 * @param {number[]} xs @param {number} p
 */
export function percentile(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

/** @param {number[]} xs */
export const median = (xs) => percentile(xs, 50);

/**
 * @param {number[]} xs
 * @returns {{n:number,min:number,p50:number,p95:number,max:number,mean:number}}
 */
export function summarize(xs) {
  if (!xs.length) return { n: 0, min: NaN, p50: NaN, p95: NaN, max: NaN, mean: NaN };
  return {
    n: xs.length,
    min: Math.min(...xs),
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    max: Math.max(...xs),
    mean: mean(xs),
  };
}

/**
 * Deterministic PRNG so bootstrap results are reproducible in reports and tests.
 * @param {number} seed
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap confidence interval for median(a) − median(b).
 * Samples are resampled independently (latency noise is far larger than any pairing signal).
 *
 * @param {number[]} a @param {number[]} b
 * @param {{iterations?:number, seed?:number, alpha?:number}} [opts]
 * @returns {{estimate:number, lo:number, hi:number, alpha:number}}
 */
export function bootstrapMedianDiff(a, b, { iterations = 2000, seed = 1, alpha = 0.05 } = {}) {
  if (!a.length || !b.length) return { estimate: NaN, lo: NaN, hi: NaN, alpha };
  const rand = mulberry32(seed);
  const resample = (xs) => Array.from({ length: xs.length }, () => xs[Math.floor(rand() * xs.length)]);
  const diffs = [];
  for (let i = 0; i < iterations; i++) diffs.push(median(resample(a)) - median(resample(b)));
  return {
    estimate: median(a) - median(b),
    lo: percentile(diffs, (alpha / 2) * 100),
    hi: percentile(diffs, (1 - alpha / 2) * 100),
    alpha,
  };
}

/**
 * Wilson score interval for a proportion. Unlike the naive ±, it stays inside [0,1] and is
 * honest at small n and at 0 % / 100 %.
 * @param {number} k successes @param {number} n trials @param {number} [z]
 */
export function wilson(k, n, z = 1.96) {
  if (n <= 0) return { p: NaN, lo: NaN, hi: NaN };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Paired bootstrap: both models answered the SAME prompts, so resample prompts, not answers.
 * Returns the accuracy difference (candidate − current) and the ratio candidate ÷ current,
 * each with a percentile interval.
 *
 * @param {number[]} current   1/0 per prompt
 * @param {number[]} candidate 1/0 per prompt, same order
 * @param {{iterations?: number, seed?: number, alpha?: number}} [opts]
 */
export function bootstrapPaired(current, candidate, { iterations = 2000, seed = 1, alpha = 0.05 } = {}) {
  const n = current.length;
  const empty = { est: NaN, lo: NaN, hi: NaN };
  if (!n || candidate.length !== n) return { diff: empty, ratio: empty, diffSd: NaN };

  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const diffs = current.map((c, i) => candidate[i] - c);
  const meanDiff = sum(diffs) / n;
  const diffSd = Math.sqrt(sum(diffs.map((d) => (d - meanDiff) ** 2)) / Math.max(1, n - 1));

  const rand = mulberry32(seed);
  const dSamples = [];
  const rSamples = [];
  for (let it = 0; it < iterations; it++) {
    let sc = 0;
    let sk = 0;
    for (let j = 0; j < n; j++) {
      const i = Math.floor(rand() * n);
      sc += current[i];
      sk += candidate[i];
    }
    dSamples.push((sk - sc) / n);
    if (sc > 0) rSamples.push(sk / sc);
  }
  const interval = (samples, est) => (samples.length ? { est, lo: percentile(samples, (alpha / 2) * 100), hi: percentile(samples, (1 - alpha / 2) * 100) } : empty);
  const sc0 = sum(current);
  return { diff: interval(dSamples, meanDiff), ratio: interval(rSamples, sc0 > 0 ? sum(candidate) / sc0 : NaN), diffSd };
}
