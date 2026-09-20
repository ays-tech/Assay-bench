import { Budget, BudgetExceededError } from './budget.js';
import { AssayNetworkError, OrbioClient } from './client.js';
import { CHECKS } from './checks/index.js';
import { readBalance, sleep } from './checks/balance.js';
import { VERSION } from './config.js';
import { formatDecimal } from './decimal.js';
import { narrate } from './narrate.js';
import { keyFingerprint, redact } from './redact.js';
import { computeScore } from './score.js';
import { buildHeadline } from './summary.js';

/**
 * Shared state for one audit. Checks read and write it; nothing else mutates it.
 *
 * @typedef {object} AuditContext
 * @property {import('./config.js').Config} config
 * @property {OrbioClient} client
 * @property {OrbioClient|null} baselineClient
 * @property {import('./catalog.js').NormalizedCatalog|null} catalog
 * @property {import('./catalog.js').CatalogModel[]} models   models chosen for the audit (each answered a preflight call)
 * @property {Array<{id:string, error:string}>} skippedModels  candidates that failed preflight
 * @property {import('./probe.js').CallRecord[]} records
 * @property {Budget} budget
 * @property {string|null} fatal                              set when nothing else can run
 * @property {{billing: import('./checks/billing.js').BatchEvaluation[], startBalance: import('./checks/balance.js').BalanceReading|null}} state
 * @property {(message: string) => void} log
 */

/**
 * @typedef {object} ProgressEvent
 * @property {'start'|'check'|'confirm'|'done'} phase
 * @property {string} [id]
 * @property {string} message
 */

/**
 * Run the audit agent: observe → plan → probe → analyze → confirm → conclude.
 * The order and escalation rules live in the checks; this function owns sequencing,
 * failure containment, and the final report.
 *
 * @param {object} opts
 * @param {import('./config.js').Config} opts.config
 * @param {OrbioClient} [opts.client]
 * @param {OrbioClient|null} [opts.baselineClient]
 * @param {(e: ProgressEvent) => void} [opts.onProgress]
 * @param {(record: import('./probe.js').CallRecord) => void} [opts.onCall]  told about every gateway call as it finishes
 * @param {typeof CHECKS} [opts.checks]
 * @returns {Promise<{report: any, catalog: import('./catalog.js').NormalizedCatalog|null}>}
 */
export async function runAudit({ config, client, baselineClient, onProgress = () => {}, onCall, checks = CHECKS }) {
  const started = new Date();
  const secrets = [config.apiKey, config.baselineKey ?? ''];
  const gateway = client ?? new OrbioClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs, label: 'Orbio' });
  const baseline =
    baselineClient !== undefined
      ? baselineClient
      : config.baselineKey
        ? new OrbioClient({ baseUrl: config.baselineUrl, apiKey: config.baselineKey, timeoutMs: config.timeoutMs, label: 'baseline' })
        : null;

  /** @type {AuditContext} */
  const ctx = {
    config, client: gateway, baselineClient: baseline, catalog: null, models: [], skippedModels: [], records: [],
    budget: new Budget(config.maxSpend), fatal: null, state: { billing: [], startBalance: null }, onCall,
    log: (m) => config.verbose && process.stderr.write(`[assay] ${redact(m, secrets)}\n`),
  };

  onProgress({ phase: 'start', message: 'Starting audit' });
  const results = [];

  for (const check of checks) {
    const t0 = performance.now();
    onProgress({ phase: 'check', id: check.id, message: `Checking: ${check.title}` });

    let outcome;
    if (ctx.fatal && check.id !== 'auth') {
      outcome = { status: /** @type {const} */ ('skip'), summary: `Skipped: ${ctx.fatal}.` };
    } else {
      outcome = await guarded(check, ctx, {}, secrets);
      if (outcome.escalate) {
        onProgress({ phase: 'confirm', id: check.id, message: `Confirming: ${check.title} (larger sample)` });
        outcome = await guarded(check, ctx, { escalated: true }, secrets);
      }
    }
    results.push({
      id: check.id, title: check.title, weight: check.weight, method: check.method, limits: check.limits,
      ...outcome, escalate: undefined, durationMs: Math.round(performance.now() - t0),
    });
  }

  // Final balance read gives the true cost of the whole audit.
  let balanceEnd = null;
  if (!ctx.fatal && ctx.state.startBalance?.available != null) {
    try {
      await sleep(Math.min(config.settlePollMs * 2, 800));
      balanceEnd = (await readBalance(gateway)).available;
    } catch {
      /* cosmetic only */
    }
  }

  const finished = new Date();
  const score = computeScore(results);
  const expected = ctx.records.reduce((s, r) => s + (r.expectedCost ?? 0n), 0n);
  const startAvail = ctx.state.startBalance?.available ?? null;

  const report = {
    schema: 'assay.report/1',
    id: started.toISOString().replace(/[:.]/g, '-'),
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    tool: { name: 'assay', version: VERSION },
    gateway: {
      host: new URL(config.baseUrl).host,
      priceUnit: ctx.catalog?.priceUnit ?? null,
      catalogSize: ctx.catalog?.models.length ?? 0,
      baseline: Boolean(baseline),
    },
    keyFingerprint: keyFingerprint(config.apiKey),
    models: ctx.models.map((m) => m.id),
    plan: { models: ctx.models.map((m) => m.id), skipped: ctx.skippedModels },
    spend: {
      calls: ctx.records.length,
      expectedUsd: formatDecimal(expected, 9),
      actualUsd: startAvail !== null && balanceEnd !== null ? formatDecimal(startAvail - balanceEnd, 9) : null,
      capUsd: formatDecimal(config.maxSpend, 6),
    },
    score,
    headline: buildHeadline(results),
    checks: results,
    records: ctx.records.map(toReportRecord),
    narrative: null,
  };

  if (config.narrate && !ctx.fatal && ctx.models.length) {
    onProgress({ phase: 'check', id: 'narrative', message: 'Writing narrative' });
    report.narrative = await narrate(ctx, report, config.narrate);
  }

  onProgress({ phase: 'done', message: 'Audit complete' });
  return { report, catalog: ctx.catalog };
}

/**
 * Run one check and contain every failure mode. A bug in Assay must never be reported as a
 * problem with the gateway, so unexpected errors become `skip`, not `fail`.
 *
 * @param {import('./checks/index.js').Check} check
 * @param {AuditContext} ctx
 * @param {{escalated?: boolean}} opts
 * @param {string[]} secrets
 * @returns {Promise<import('./checks/index.js').CheckOutcome>}
 */
async function guarded(check, ctx, opts, secrets) {
  try {
    return await check.run(ctx, opts);
  } catch (err) {
    const message = redact(err?.message ?? String(err), secrets);
    if (err instanceof BudgetExceededError) {
      return { status: 'skip', summary: `Spend cap reached before this check could finish. ${message}` };
    }
    if (err instanceof AssayNetworkError) {
      if (check.id === 'auth') {
        ctx.fatal = 'the gateway was unreachable';
        return { status: 'fail', summary: `Could not reach the gateway: ${message}. Check ORBIO_BASE_URL and your network.` };
      }
      return { status: 'warn', summary: `Network error during this check: ${message}.` };
    }
    ctx.log(`internal error in ${check.id}: ${redact(err?.stack ?? message, secrets)}`);
    return { status: 'skip', summary: `Assay hit an internal error and skipped this check: ${message}`, details: { internalError: true } };
  }
}

/** @param {import('./probe.js').CallRecord & {billedEstimate?: bigint|null}} r */
function toReportRecord(r) {
  return {
    tag: r.tag,
    source: r.source,
    model: r.model,
    respModel: r.respModel,
    ok: r.ok,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    latencyMs: Math.round(r.latencyMs),
    expectedUsd: r.expectedCost === null ? null : formatDecimal(r.expectedCost, 9),
    billedUsd: r.billedEstimate == null ? null : formatDecimal(r.billedEstimate, 9),
    error: r.error,
  };
}
