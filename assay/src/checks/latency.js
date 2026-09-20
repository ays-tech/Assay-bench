import { BudgetExceededError } from '../budget.js';
import { probeChat } from '../probe.js';
import { bootstrapMedianDiff, summarize } from '../stats.js';

export const CLAIM_MS = 50;
const MIN_SAMPLES = 5;

/**
 * Pure: is the added latency below the claim, with statistical honesty?
 * pass  → the 95 % CI upper bound is under the claim
 * warn  → the point estimate is under, but the CI crosses the claim (inconclusive)
 * fail  → the CI lower bound is above the claim
 * @param {number[]} gateway @param {number[]} baseline
 * @param {{claimMs?: number, seed?: number}} [opts]
 */
export function evaluateOverhead(gateway, baseline, { claimMs = CLAIM_MS, seed = 7 } = {}) {
  if (gateway.length < MIN_SAMPLES || baseline.length < MIN_SAMPLES) {
    return { verdict: /** @type {const} */ ('insufficient'), estimate: NaN, lo: NaN, hi: NaN, claimMs };
  }
  const ci = bootstrapMedianDiff(gateway, baseline, { seed });
  const verdict = ci.hi < claimMs ? 'pass' : ci.lo > claimMs ? 'fail' : 'warn';
  return { verdict: /** @type {'pass'|'warn'|'fail'} */ (verdict), estimate: ci.estimate, lo: ci.lo, hi: ci.hi, claimMs };
}

const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
const signed = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n))} ms`;

/** @type {import('./index.js').Check} */
export const latencyCheck = {
  id: 'latency',
  title: 'Added latency',
  weight: 10,
  method:
    'With a baseline key (ASSAY_BASELINE_KEY, a direct OpenRouter key): alternates identical tiny requests through Orbio and directly, and bootstraps a 95% interval for the difference of medians. ' +
    'Without one: reports the gateway\'s own round-trip on /key (no model involved) and per-model latency, which bound but do not isolate the overhead.',
  limits: 'Overhead cannot be isolated without a baseline. Results include your own network distance to each endpoint and vary by region and time of day.',

  async run(ctx) {
    // Gateway floor: /key touches auth and the ledger but no upstream model. First request warms the connection.
    const rtts = [];
    for (let i = 0; i < 11; i++) {
      const res = await ctx.client.request('/key');
      if (i > 0 && res.ok) rtts.push(res.elapsedMs);
    }
    const floor = summarize(rtts);

    const perModel = {};
    for (const r of ctx.records.filter((x) => x.source === 'gateway' && x.tag === 'billing' && x.ok)) (perModel[r.model] ??= []).push(r.latencyMs);
    const modelStats = Object.fromEntries(Object.entries(perModel).map(([m, xs]) => [m, summarize(xs)]));

    // Self-reported overhead, if the gateway exposes it. Informational: it is Orbio's own number.
    const selfReported = [];
    for (const r of ctx.records) {
      for (const [name, value] of Object.entries(r.headers)) {
        const n = Number(String(value).replace(/[^\d.]/g, ''));
        if (/overhead|added-?latency|gateway-?(ms|time)/i.test(name) && Number.isFinite(n)) selfReported.push(n);
      }
    }

    if (!ctx.baselineClient || !ctx.models.length) {
      return {
        status: 'info',
        summary: `Gateway round-trip p50 ${round(floor.p50)} ms (p95 ${round(floor.p95)} ms) on /key with no model involved. Set ASSAY_BASELINE_KEY to measure the added latency against the provider directly.`,
        measured: { floorP50: round(floor.p50), floorP95: round(floor.p95), claimMs: CLAIM_MS, selfReportedMs: selfReported.length ? summarize(selfReported).p50 : null },
        details: { floor, perModel: modelStats, selfReported },
      };
    }

    const model = ctx.models[0];
    const viaGateway = [];
    const direct = [];
    try {
      for (let i = 0; i < 10; i++) {
        // Alternate order so drift and warm-up don't favour either side.
        const order = i % 2 === 0 ? ['gateway', 'direct'] : ['direct', 'gateway'];
        for (const side of order) {
          const isDirect = side === 'direct';
          const rec = await probeChat(ctx, model, {
            prompt: 'Reply with the single word: ok', maxTokens: 4, tag: 'latency',
            client: isDirect ? ctx.baselineClient : ctx.client, source: isDirect ? 'baseline' : 'gateway',
          });
          if (rec.ok) (isDirect ? direct : viaGateway).push(rec.latencyMs);
        }
      }
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
    }

    const ev = evaluateOverhead(viaGateway, direct);
    if (ev.verdict === 'insufficient') {
      return {
        status: 'skip',
        summary: `Only ${viaGateway.length} gateway and ${direct.length} direct samples succeeded; need ${MIN_SAMPLES} of each. Check the baseline key and that ${model.id} exists on the baseline endpoint.`,
        measured: { gatewaySamples: viaGateway.length, directSamples: direct.length },
      };
    }
    const range = `95% CI ${signed(ev.lo)} to ${signed(ev.hi)}`;
    const summary = {
      pass: `Orbio added ${signed(ev.estimate)} over direct (${range}), under the ${CLAIM_MS} ms claim.`,
      warn: `Orbio added ${signed(ev.estimate)} over direct, but the ${range} crosses the ${CLAIM_MS} ms claim. Inconclusive; re-run with more samples.`,
      fail: `Orbio added ${signed(ev.estimate)} over direct (${range}), above the ${CLAIM_MS} ms claim.`,
    }[ev.verdict];
    return {
      status: ev.verdict,
      summary,
      measured: { overheadMs: round(ev.estimate), ciLo: round(ev.lo), ciHi: round(ev.hi), claimMs: CLAIM_MS, gatewaySamples: viaGateway.length, directSamples: direct.length, floorP50: round(floor.p50) },
      details: { model: model.id, gateway: summarize(viaGateway), direct: summarize(direct), floor, samples: { gateway: viaGateway.map(round), direct: direct.map(round) } },
    };
  },
};
