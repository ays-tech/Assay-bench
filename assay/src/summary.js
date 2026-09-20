/** Deterministic, human-readable summaries built only from measured results. */

const PASS_NAMES = { billing: 'billing', identity: 'model identity', tokens: 'token counts', compat: 'API behaviour', latency: 'added latency', auth: 'authentication' };
const FAIL_PHRASES = {
  billing: 'Orbio billed above the catalog price.',
  identity: 'A requested model answered as a different one.',
  tokens: 'Reported token counts do not add up.',
  compat: 'Streaming or tool calls differ from the OpenAI API.',
  latency: 'Added latency is above the 50 ms claim.',
  auth: 'Authentication is not being enforced.',
  catalog: 'The model catalog could not be read.',
};
const WARN_PHRASES = {
  billing: 'Billing needs a second look.',
  identity: 'Model identity evidence is weaker than it should be.',
  tokens: 'Token accounting has irregularities.',
  compat: 'Some API behaviour differs from OpenAI.',
  latency: 'The latency claim could not be confirmed.',
  auth: 'Credential handling has minor gaps.',
  catalog: 'The catalog has anomalies.',
};

/** @param {string[]} items */
function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** @param {string} s */
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One sentence that says what happened.
 * @param {Array<{id:string,status:string}>} checks
 */
export function buildHeadline(checks) {
  const core = buildCoreHeadline(checks);
  const billingSkipped = checks.some((c) => c.id === 'billing' && c.status === 'skip');
  return billingSkipped ? `${core} Billing could not be verified on this run.` : core;
}

/** @param {Array<{id:string,status:string}>} checks */
function buildCoreHeadline(checks) {
  const by = (status) => checks.filter((c) => c.status === status);
  const fails = by('fail');
  const warns = by('warn');
  const passes = by('pass');

  if (fails.length) return fails.slice(0, 2).map((c) => FAIL_PHRASES[c.id] ?? `${c.id} failed.`).join(' ');
  if (warns.length) {
    const lead = warns.slice(0, 2).map((c) => WARN_PHRASES[c.id] ?? `${c.id} needs review.`).join(' ');
    return passes.length ? `No failures. ${lead}` : lead;
  }
  if (!passes.length) return 'Assay could not verify anything on this run.';
  const named = passes.map((c) => PASS_NAMES[c.id]).filter(Boolean);
  return `${capitalize(joinList(named))} held up.`;
}

/**
 * Compact facts for the dashboard and terminal.
 * @param {{checks: Array<{status:string}>, spend: {calls:number, actualUsd?:string|null, expectedUsd:string}, models: string[], score:{coverage:number}}} report
 */
export function buildFacts(report) {
  const ran = report.checks.filter((c) => ['pass', 'warn', 'fail'].includes(c.status)).length;
  return {
    calls: report.spend.calls,
    models: report.models.length,
    spendUsd: report.spend.actualUsd ?? report.spend.expectedUsd,
    checksRan: ran,
    checksTotal: report.checks.length,
    coverage: report.score.coverage,
  };
}
