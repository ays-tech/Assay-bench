/**
 * Fineness: purity in parts per thousand, borrowed from hallmarking.
 *
 * Only checks that actually ran (pass/warn/fail) count. Skipped and info-only checks are
 * excluded, and *coverage* reports how much of the total weight that leaves, so a score built
 * from little evidence is never mistaken for a strong one.
 */

const POINTS = { pass: 1, warn: 0.5, fail: 0 };
/** A failure here means the money or the model is wrong; it must not be averaged away. */
export const INTEGRITY_CHECKS = ['billing', 'tokens', 'identity', 'auth'];
export const INTEGRITY_CAP = 600;

/** Below this coverage the top grade is withheld: a clean result on little evidence is not "Verified". */
export const FULL_COVERAGE = 0.8;

/**
 * @param {number|null} fineness
 * @param {number} [coverage]
 * @returns {string}
 */
export function gradeFor(fineness, coverage = 1) {
  if (fineness === null) return 'Not enough evidence';
  if (fineness >= 950) return coverage >= FULL_COVERAGE ? 'Verified' : 'Partially verified';
  if (fineness >= 800) return 'Mostly verified';
  if (fineness >= 500) return 'Concerns';
  return 'Failed';
}

/**
 * @param {Array<{id:string, weight:number, status:string}>} results
 * @returns {{fineness:number|null, grade:string, coverage:number, capped:boolean, confidence:'high'|'partial'|'low'}}
 */
export function computeScore(results) {
  const total = results.reduce((s, r) => s + r.weight, 0);
  const counted = results.filter((r) => r.status in POINTS);
  const ran = counted.reduce((s, r) => s + r.weight, 0);
  const coverage = total ? ran / total : 0;
  if (!ran) return { fineness: null, grade: gradeFor(null), coverage: 0, capped: false, confidence: 'low' };

  const earned = counted.reduce((s, r) => s + r.weight * POINTS[/** @type {keyof typeof POINTS} */ (r.status)], 0);
  let fineness = Math.round((1000 * earned) / ran);
  const integrityFailure = counted.some((r) => INTEGRITY_CHECKS.includes(r.id) && r.status === 'fail');
  const capped = integrityFailure && fineness > INTEGRITY_CAP;
  if (capped) fineness = INTEGRITY_CAP;

  return {
    fineness,
    grade: gradeFor(fineness, coverage),
    coverage: Math.round(coverage * 100) / 100,
    capped,
    confidence: coverage >= FULL_COVERAGE ? 'high' : coverage >= 0.5 ? 'partial' : 'low',
  };
}
