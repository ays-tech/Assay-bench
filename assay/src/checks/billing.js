import { BudgetExceededError } from '../budget.js';
import { CANARY_PROMPT, probeChat } from '../probe.js';
import { readBalance, sleep } from './balance.js';
import { abs, formatDecimal, ratio, resolutionOf, scaleBy } from '../decimal.js';

/** A batch is only conclusive if the expected cost is at least this many times the rounding slack. */
const RESOLVABILITY_FACTOR = 5n;

/**
 * @typedef {object} Batch
 * @property {import('../probe.js').CallRecord[]} calls
 * @property {import('./balance.js').BalanceReading} before
 * @property {import('./balance.js').BalanceReading & {settled:boolean, waitedMs:number}} after
 * @property {boolean} budgetStopped
 */

/**
 * @typedef {object} BatchEvaluation
 * @property {'ok'|'over'|'nocharge'|'unresolvable'|'nodata'} verdict
 * @property {bigint} expected      Σ tokens × catalog price over successful calls
 * @property {bigint} billed        balance before − balance after
 * @property {number|null} ratio    billed ÷ expected
 * @property {bigint} resolution    smallest balance step observable
 * @property {bigint} slack         rounding allowance
 * @property {number} calls
 * @property {{ok:boolean, deltaAvailable:bigint, deltaUsed:bigint}|null} conservation
 * @property {{reported:bigint, matches:boolean}|null} reportedCost
 * @property {Array<{model:string, expected:bigint|null, billed:bigint|null}>} perCall
 * @property {boolean} settled
 * @property {number} waitedMs
 * @property {boolean} budgetStopped
 */

/**
 * Pure: judge one batch of paid calls against the balance movement.
 * @param {Batch} batch
 * @param {{tolerance: number}} opts
 * @returns {BatchEvaluation}
 */
export function evaluateBatch(batch, { tolerance }) {
  const { calls, before, after } = batch;
  const okCalls = calls.filter((c) => c.ok && c.expectedCost !== null);
  const expected = okCalls.reduce((sum, c) => sum + /** @type {bigint} */ (c.expectedCost), 0n);
  const resolution = resolutionOf([before.availableRaw, before.usedRaw, after.availableRaw, after.usedRaw, ...calls.map((c) => c.balanceHeaderRaw)]);
  const slack = BigInt(okCalls.length + 1) * resolution;
  const billed = (before.available ?? 0n) - (after.available ?? 0n);

  /** @type {BatchEvaluation['verdict']} */
  let verdict;
  if (!okCalls.length) verdict = 'nodata';
  else if (expected < RESOLVABILITY_FACTOR * slack) verdict = 'unresolvable';
  else if (billed > expected + scaleBy(expected, tolerance) + slack) verdict = 'over';
  else if (billed <= slack) verdict = 'nocharge';
  else verdict = 'ok';

  // Funds must move from `available` to `used`, not vanish.
  let conservation = null;
  if (before.used !== null && after.used !== null && before.available !== null && after.available !== null) {
    const deltaAvailable = before.available - after.available;
    const deltaUsed = after.used - before.used;
    conservation = { ok: abs(deltaAvailable - deltaUsed) <= slack, deltaAvailable, deltaUsed };
  }

  // If the gateway reports per-call cost (`usage.cost`), it should agree with the balance.
  let reportedCost = null;
  if (okCalls.length && okCalls.every((c) => c.reportedCost !== null)) {
    const reported = okCalls.reduce((sum, c) => sum + /** @type {bigint} */ (c.reportedCost), 0n);
    reportedCost = { reported, matches: abs(reported - billed) <= scaleBy(billed, tolerance) + slack };
  }

  // The X-Orbio-Balance header is the balance each request *started* from, so consecutive
  // differences give per-call charges (when charges land promptly).
  const perCall = calls.map((c, i) => {
    const nextCall = calls[i + 1];
    const next = nextCall ? nextCall.balanceHeader : after.available;
    const canChain = c.balanceHeader !== null && next !== null;
    return {
      model: c.model,
      expected: c.expectedCost,
      billed: canChain ? c.balanceHeader - next : null,
    };
  });

  return {
    verdict, expected, billed, ratio: ratio(billed, expected), resolution, slack,
    calls: okCalls.length, conservation, reportedCost, perCall,
    settled: after.settled, waitedMs: after.waitedMs, budgetStopped: batch.budgetStopped,
  };
}

/**
 * Pure: combine one or more batch evaluations into a check verdict.
 * A failure requires *every* batch to be over; a single anomaly is only a warning and
 * requests confirmation.
 * @param {BatchEvaluation[]} evals
 * @param {{tolerance?: number}} [opts]
 * @returns {{status:'pass'|'warn'|'fail'|'skip', summary:string, escalate:boolean}}
 */
export function judgeBatches(evals, { tolerance = 0.02 } = {}) {
  const last = evals[evals.length - 1];
  const overs = evals.filter((e) => e.verdict === 'over');

  if (overs.length === evals.length && evals.length > 1) {
    return {
      status: 'fail', escalate: false,
      summary: `Billed above catalog price in ${evals.length} independent batches (${evals.map((e) => fmtRatio(e.ratio)).join(', ')}).`,
    };
  }
  if (overs.length > 0) {
    const confirmed = evals.length > 1;
    return {
      status: 'warn', escalate: !confirmed,
      summary: confirmed
        ? `One batch billed above catalog price (${overs.map((e) => fmtRatio(e.ratio)).join(', ')}) but a second did not. Unexplained; other clients using this key can cause this.`
        : `Billed ${fmtRatio(last.ratio)}, above the ${(tolerance * 100).toFixed(0)}% tolerance. Re-running a larger batch to confirm.`,
    };
  }

  switch (last.verdict) {
    case 'nodata':
      return { status: 'skip', escalate: false, summary: 'No paid call succeeded, so billing could not be checked. Check the key has balance.' };
    case 'unresolvable':
      return {
        status: 'skip', escalate: false,
        summary: `Balance precision ($${formatDecimal(last.resolution, 9)}) is too coarse to resolve $${formatDecimal(last.expected, 9)} of usage within the spend cap.`,
      };
    case 'nocharge':
      return {
        status: 'warn', escalate: false,
        summary: `No charge appeared within ${Math.round(last.waitedMs / 1000)}s for $${formatDecimal(last.expected, 9)} of usage (free grant, slow settlement, or not billed).`,
      };
    default: {
      const conserved = last.conservation ? last.conservation.ok : true;
      const under = last.ratio !== null && last.ratio < 0.98;
      // Billed at under half the catalog price is either a large undisclosed discount or, far more
      // likely, a measurement that missed charges still landing. Neither is a clean pass.
      if (last.ratio !== null && last.ratio < 0.5) {
        return {
          status: 'warn', escalate: false,
          summary: `Billed only ${fmtRatio(last.ratio)} ($${formatDecimal(last.billed, 9)} for $${formatDecimal(last.expected, 9)} of usage). Either a large discount or charges were still landing when the balance was read; not confirmed.`,
        };
      }
      return {
        status: conserved ? 'pass' : 'warn', escalate: false,
        summary:
          `Billed $${formatDecimal(last.billed, 9)} for $${formatDecimal(last.expected, 9)} of catalog-priced usage over ${last.calls} calls (${fmtRatio(last.ratio)})` +
          (under ? ', below catalog price' : '') +
          (conserved ? '. Funds conserved.' : '. Balance and usage counters did not move together.'),
      };
    }
  }
}

/** @param {number|null} r */
const fmtRatio = (r) => (r === null ? 'n/a' : `${r.toFixed(3)}× catalog`);

/**
 * Poll the balance until the charge for the batch has landed and stopped changing.
 * The docs note a charge lands *after* the answer it pays for.
 * @param {import('../agent.js').AuditContext} ctx
 * @param {import('./balance.js').BalanceReading} before
 */
export async function settleBalance(ctx, before) {
  const started = Date.now();
  let previous = null;
  let stablePolls = 0;
  let reading = await readBalance(ctx.client);
  for (;;) {
    const changed = reading.available !== before.available;
    stablePolls = previous !== null && reading.available === previous ? stablePolls + 1 : 0;
    previous = reading.available;
    const settled = changed && stablePolls >= 2;
    if (settled || Date.now() - started >= ctx.config.settleTimeoutMs) {
      return { ...reading, settled, waitedMs: Date.now() - started };
    }
    await sleep(ctx.config.settlePollMs);
    reading = await readBalance(ctx.client);
  }
}

/**
 * Wait until charges for calls already made have landed on the balance. Without this, the
 * charge for an earlier call (a preflight, a previous batch) can arrive *inside* the next
 * measurement window and look like an overcharge.
 *
 * Done when the balance has dropped by ~the expected spend, or has stopped moving for a while.
 * @param {{client: import('../client.js').OrbioClient, config: {settleTimeoutMs: number, settlePollMs: number}}} ctx
 * @param {bigint|null} startAvailable balance before any of those calls
 * @param {bigint} expected catalog-priced cost of the calls made since
 */
export async function waitForCharges(ctx, startAvailable, expected) {
  if (startAvailable === null || expected <= 0n) return 0;
  const started = Date.now();
  const limit = Math.min(ctx.config.settleTimeoutMs, 6000);
  // Only give up early on a quiet balance after longer than a slow gateway plausibly takes to
  // post a charge; leaving early is what lets a stray charge land inside the next window.
  const patience = Math.min(limit, 2500);
  let last = null;
  let quiet = 0;
  for (;;) {
    const reading = await readBalance(ctx.client);
    if (reading.available === null) return Date.now() - started;
    if (startAvailable - reading.available >= scaleBy(expected, 0.9)) return Date.now() - started;
    quiet = reading.available === last ? quiet + 1 : 0;
    last = reading.available;
    const elapsed = Date.now() - started;
    if (elapsed >= limit || (quiet >= 4 && elapsed >= patience)) return elapsed;
    await sleep(ctx.config.settlePollMs);
  }
}
async function collectBatch(ctx, { minRounds, maxRounds }) {
  // Everything spent so far (preflight, earlier batches) must be on the balance before we measure.
  const priorSpend = ctx.records.filter((r) => r.source === 'gateway' && r.ok).reduce((sum, r) => sum + (r.expectedCost ?? 0n), 0n);
  await waitForCharges(ctx, ctx.state.startBalance?.available ?? null, priorSpend);
  const before = await readBalance(ctx.client);
  if (before.available === null) throw new Error('Balance unreadable before billing batch');

  /** @type {import('../probe.js').CallRecord[]} */
  const calls = [];
  let budgetStopped = false;
  try {
    for (let round = 0; round < maxRounds; round++) {
      for (const model of ctx.models) calls.push(await probeChat(ctx, model, { prompt: CANARY_PROMPT, maxTokens: 16, tag: 'billing' }));
      if (isHopeless(calls, before)) break;
      if (round + 1 >= minRounds && isResolvable(calls, before)) break;
    }
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    budgetStopped = true;
  }
  // No point waiting for a charge we already know cannot be resolved.
  const after = isHopeless(calls, before)
    ? { ...(await readBalance(ctx.client)), settled: false, waitedMs: 0 }
    : await settleBalance(ctx, before);
  return { calls, before, after, budgetStopped };
}

/** @param {import('../probe.js').CallRecord[]} calls @param {import('./balance.js').BalanceReading} before */
function isResolvable(calls, before) {
  const ok = calls.filter((c) => c.ok && c.expectedCost !== null);
  const expected = ok.reduce((s, c) => s + /** @type {bigint} */ (c.expectedCost), 0n);
  const res = resolutionOf([before.availableRaw, before.usedRaw, ...calls.map((c) => c.balanceHeaderRaw)]);
  return expected >= RESOLVABILITY_FACTOR * BigInt(ok.length + 1) * res;
}

/**
 * Slack grows by one balance unit per call, so if an average call costs no more than
 * RESOLVABILITY_FACTOR units, more calls can never make the batch conclusive. Stop spending.
 * @param {import('../probe.js').CallRecord[]} calls @param {import('./balance.js').BalanceReading} before
 */
function isHopeless(calls, before) {
  const ok = calls.filter((c) => c.ok && c.expectedCost !== null);
  if (!ok.length) return calls.length >= 3; // repeated failures: don't keep paying for errors
  const expected = ok.reduce((s, c) => s + /** @type {bigint} */ (c.expectedCost), 0n);
  const res = resolutionOf([before.availableRaw, before.usedRaw, ...calls.map((c) => c.balanceHeaderRaw)]);
  return expected <= RESOLVABILITY_FACTOR * res * BigInt(ok.length);
}

/** @type {import('./index.js').Check} */
export const billingCheck = {
  id: 'billing',
  title: 'Billing matches catalog price',
  weight: 30,
  method:
    'Reads the balance, sends fixed ~450-token canary calls, waits for the charge to land, then compares the balance drop with Σ(tokens × catalog price) in exact decimals. ' +
    'Tolerance is 2% plus one unit of balance precision per call. A failure needs two independent batches to agree.',
  limits:
    'Only sees charges on this key: other clients using it during the audit look like overcharging (use a dedicated key). ' +
    'Assumes metered usage is billed at catalog rate; the discount is applied when credit is purchased.',

  async run(ctx, { escalated = false } = {}) {
    if (!ctx.models.length) return { status: 'skip', summary: 'No models selected to audit.' };
    const { minRounds, maxRounds } = ctx.config;
    const batch = await collectBatch(ctx, escalated ? { minRounds: maxRounds, maxRounds: maxRounds + 2 } : { minRounds, maxRounds });
    const evaluation = evaluateBatch(batch, { tolerance: ctx.config.tolerance });

    // Attach per-call charges to records so the dashboard can plot them.
    batch.calls.forEach((rec, i) => Object.assign(rec, { billedEstimate: evaluation.perCall[i].billed }));

    ctx.state.billing.push(evaluation);
    const verdict = judgeBatches(ctx.state.billing, { tolerance: ctx.config.tolerance });
    const latest = evaluation;

    return {
      status: verdict.status,
      summary: verdict.summary,
      escalate: verdict.escalate,
      measured: {
        ratio: latest.ratio,
        billed: formatDecimal(latest.billed, 9),
        expected: formatDecimal(latest.expected, 9),
        calls: latest.calls,
        balanceResolution: formatDecimal(latest.resolution, 9),
        settleWaitMs: latest.waitedMs,
        batches: ctx.state.billing.length,
      },
      details: {
        batches: ctx.state.billing.map((e) => ({
          verdict: e.verdict,
          ratio: e.ratio,
          billed: formatDecimal(e.billed, 9),
          expected: formatDecimal(e.expected, 9),
          calls: e.calls,
          settled: e.settled,
          budgetStopped: e.budgetStopped,
          conservation: e.conservation && { ok: e.conservation.ok, deltaAvailable: formatDecimal(e.conservation.deltaAvailable, 9), deltaUsed: formatDecimal(e.conservation.deltaUsed, 9) },
          reportedCost: e.reportedCost && { reported: formatDecimal(e.reportedCost.reported, 9), matches: e.reportedCost.matches },
        })),
      },
    };
  },
};
