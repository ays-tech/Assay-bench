import { Budget, BudgetExceededError } from '../budget.js';
import { PREFERRED_VENDORS, UNSUITABLE_ID, findModel, normalizeCatalog } from '../catalog.js';
import { evaluateBatch, settleBalance, waitForCharges } from '../checks/billing.js';
import { readBalance } from '../checks/balance.js';
import { VERSION } from '../config.js';
import { formatDecimal } from '../decimal.js';
import { probeChat } from '../probe.js';
import { redact, clip } from '../redact.js';
import { bootstrapPaired, mulberry32, percentile, wilson } from '../stats.js';
import { runChecks } from './checks.js';
import { combineVerdicts, judgeCandidates, judgeMessages, parseVerdict } from './judge.js';
import { createRateLimiter, mapLimit } from './pool.js';
import { describe, recommend } from './recommend.js';

export class BenchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BenchError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (bigint) => Number(bigint) / 1e18;
const lastUser = (item) => [...item.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

/**
 * Cheaper candidates from several vendors. Per vendor, the *priciest* model that is still well
 * under the current one (the likeliest to hold up), plus the absolute cheapest overall as a
 * floor, which shows where quality falls off.
 *
 * @param {import('../catalog.js').CatalogModel[]} models
 * @param {import('../catalog.js').CatalogModel} current
 * @param {{avgPromptTokens?: number, avgCompletionTokens?: number, count?: number, maxRatio?: number}} [opts]
 */
export function autoCandidates(models, current, { avgPromptTokens = 250, avgCompletionTokens = 120, count = 4, maxRatio = 0.5 } = {}) {
  const cost = (m) => num(m.promptPrice) * avgPromptTokens + num(m.completionPrice) * avgCompletionTokens;
  const limit = cost(current) * maxRatio;
  const usable = models.filter(
    (m) => m.id !== current.id && m.promptPrice !== null && m.completionPrice !== null && m.completionPrice > 0n && !UNSUITABLE_ID.test(m.id) &&
      (m.contextLength === null || m.contextLength >= 8192) && (m.outputModalities === null || m.outputModalities.includes('text')) && cost(m) <= limit,
  );
  const rank = (v) => (PREFERRED_VENDORS.includes(v) ? PREFERRED_VENDORS.indexOf(v) : PREFERRED_VENDORS.length);
  const bestPerVendor = new Map();
  for (const m of usable) {
    const cur = bestPerVendor.get(m.vendor);
    if (!cur || cost(m) > cost(cur)) bestPerVendor.set(m.vendor, m);
  }
  const picks = [...bestPerVendor.values()].sort((a, b) => rank(a.vendor) - rank(b.vendor)).slice(0, Math.max(1, count - 1));
  const floor = [...usable].sort((a, b) => cost(a) - cost(b))[0];
  if (floor && !picks.some((m) => m.id === floor.id)) picks.push(floor);
  return picks.slice(0, count);
}

/** Deterministic subsample that keeps the dataset's original order. */
export function sampleItems(items, limit, seed = 1) {
  if (!limit || limit >= items.length) return items;
  const rand = mulberry32(seed);
  const order = items.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, limit).sort((a, b) => a - b).map((i) => items[i]);
}

/**
 * Rough dollars for one call, used for the pre-run estimate (not for billing).
 * @param {import('../catalog.js').CatalogModel} m @param {number} promptTokens @param {number} completionTokens
 */
const callUsd = (m, promptTokens, completionTokens) => num(m.promptPrice) * promptTokens + num(m.completionPrice) * completionTokens;

/**
 * @typedef {object} BenchOptions
 * @property {import('../config.js').Config} config
 * @property {import('../client.js').OrbioClient} client
 * @property {import('./dataset.js').BenchItem[]} dataset
 * @property {string} datasetName
 * @property {string} current                       model id you use today
 * @property {'auto'|string[]} [candidates]
 * @property {string|null} [judge]                  model id, or null to choose automatically
 * @property {number} [limit]                       score at most this many prompts
 * @property {number} [maxTokens]
 * @property {number} [marginPts] @property {number} [minSamples] @property {number} [minSavings]
 * @property {number} [concurrency] @property {number} [rpm]
 * @property {boolean} [samples]                    keep short excerpts of failures in the report
 * @property {boolean} [dryRun]                     plan and estimate only, spend nothing
 * @property {any} [auditSummary]                   latest Assay audit of this gateway, embedded as trust context
 * @property {(e: {phase: string, message: string, done?: number, total?: number}) => void} [onProgress]
 * @property {(record: import('../probe.js').CallRecord) => void} [onCall]     told about every gateway call as it finishes
 * @property {(a: {model: string, correct: boolean|null}) => void} [onAnswer]  told as each answer is checked; null = a judge decides later
 */

/**
 * Shadow-run your prompts against several models and report which cheaper one is good enough.
 * @param {BenchOptions} opts
 */
export async function runBench(opts) {
  const {
    config, client, datasetName, current: currentId, candidates = 'auto', judge: judgeId = null,
    limit, maxTokens = 400, marginPts = 5, minSamples = 20, minSavings = 0.1, concurrency = 4, rpm = 90,
    samples = true, dryRun = false, auditSummary = null, onProgress = () => {}, onCall, onAnswer,
  } = opts;
  const started = new Date();
  const secrets = [config.apiKey];
  const items = sampleItems(opts.dataset, limit);
  const notes = [];
  const skipped = [];

  /* ---- 1. plan ---- */
  onProgress({ phase: 'plan', message: 'Reading the model catalog' });
  const res = await client.get('/models');
  if (!res.ok || !res.json) throw new BenchError(`Could not read the model catalog (HTTP ${res.status}).`);
  const catalog = normalizeCatalog(res.json, { priceUnit: config.priceUnit });

  const currentModel = findModel(catalog.models, currentId);
  if (!currentModel || currentModel.promptPrice === null || currentModel.completionPrice === null) {
    const near = catalog.models.filter((m) => m.id.toLowerCase().includes(currentId.split('/').pop().toLowerCase().slice(0, 8))).slice(0, 4).map((m) => m.id);
    throw new BenchError(`Current model "${currentId}" was not found (or has no price) in the catalog.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
  }

  const avgPromptTokens = Math.max(20, Math.round(items.reduce((n, it) => n + it.messages.reduce((k, m) => k + m.content.length, 0), 0) / items.length / 3.5));
  let candidateModels;
  if (candidates === 'auto') {
    candidateModels = autoCandidates(catalog.models, currentModel, { avgPromptTokens });
    if (!candidateModels.length) throw new BenchError(`No cheaper model found to compare against ${currentId}. Name candidates explicitly with --candidates.`);
  } else {
    candidateModels = [];
    for (const id of candidates) {
      const m = findModel(catalog.models, id);
      if (m && m.promptPrice !== null && m.completionPrice !== null && m.id !== currentModel.id) candidateModels.push(m);
      else skipped.push({ id, error: m?.id === currentModel.id ? 'is the current model' : 'not found or unpriced in the catalog' });
    }
    if (!candidateModels.length) throw new BenchError('None of the candidate models could be used.');
  }

  const ctx = { client, budget: new Budget(config.maxSpend), records: /** @type {import('../probe.js').CallRecord[]} */ ([]), config, log: () => {}, onCall };
  const balanceAtStart = (await readBalance(client)).available;

  // Prove every model can answer before spending on the real run.
  onProgress({ phase: 'plan', message: 'Checking each model can answer' });
  const working = [];
  for (const m of [currentModel, ...candidateModels]) {
    const rec = await probeChat(ctx, m, { prompt: 'Reply with the single word: ok', maxTokens: 8, tag: 'preflight' });
    if (rec.ok) working.push(m);
    else if (m.id === currentModel.id) throw new BenchError(`The current model ${m.id} did not answer: ${redact(rec.error ?? 'no response', secrets)}`);
    else skipped.push({ id: m.id, error: clip(rec.error ?? 'no response', 160) });
  }
  const models = working; // current model first
  const candidatesUsed = models.slice(1);
  if (!candidatesUsed.length) throw new BenchError('No candidate model answered a preflight call, so there is nothing to compare.');

  // Judge models are chosen per candidate: never the current model's vendor, never the candidate's.
  const judged = items.filter((it) => it.judge);
  /** @type {Map<string, import('../catalog.js').CatalogModel>} */
  const judgeFor = new Map();
  /** @type {Map<string, boolean>} */
  const judgeOk = new Map();
  if (judged.length) {
    onProgress({ phase: 'plan', message: 'Choosing a judge model' });
    for (const c of candidatesUsed) {
      const pool = judgeId
        ? [findModel(catalog.models, judgeId)].filter(Boolean)
        : judgeCandidates(catalog.models, { avoid: new Set([currentModel.vendor, c.vendor]), exclude: new Set([currentModel.id, c.id]) });
      for (const j of pool) {
        if (!judgeOk.has(j.id)) judgeOk.set(j.id, (await probeChat(ctx, j, { prompt: 'Reply with the single word: ok', maxTokens: 8, tag: 'preflight' })).ok);
        if (judgeOk.get(j.id)) { judgeFor.set(c.id, j); break; }
      }
      if (!judgeFor.has(c.id)) throw new BenchError(judgeId ? `The judge model ${judgeId} could not be used.` : `No judge model is available from a vendor other than ${currentModel.vendor} and ${c.vendor}. Pass --judge <model>.`);
    }
    for (const c of candidatesUsed) {
      const j = judgeFor.get(c.id);
      if (j.vendor === c.vendor || j.vendor === currentModel.vendor) notes.push(`The judge ${j.id} shares a vendor with ${j.vendor === c.vendor ? c.id : currentModel.id}; models tend to favour their own family, so treat its verdicts on that comparison with caution.`);
    }
  }

  // Cost estimate before a cent is spent on the real run.
  const typical = (m) => callUsd(m, avgPromptTokens, Math.min(maxTokens, 80)); // a fair guess; the hard spend cap enforces the real limit
  const shadowEstimate = models.reduce((sum, m) => sum + typical(m) * items.length, 0);
  const judgeEstimate = candidatesUsed.reduce((sum, c) => sum + (judgeFor.get(c.id) ? callUsd(judgeFor.get(c.id), 700, 30) * 2 * judged.length : 0), 0);
  const estimate = { calls: models.length * items.length + candidatesUsed.length * judged.length * 2, usd: shadowEstimate + judgeEstimate };
  const plan = {
    current: currentModel.id,
    candidates: candidatesUsed.map((m) => m.id),
    judges: Object.fromEntries([...judgeFor].map(([c, j]) => [c, j.id])),
    prompts: items.length,
    judgedPrompts: judged.length,
    estimate,
    capUsd: num(config.maxSpend),
    skipped,
  };
  if (dryRun) return { plan };
  if (estimate.usd > num(config.maxSpend)) {
    throw new BenchError(`Estimated cost $${estimate.usd.toFixed(4)} exceeds the spend cap $${num(config.maxSpend).toFixed(2)}. Lower --limit, name fewer candidates, or raise --max-spend.`);
  }

  /* ---- 2. shadow-run ---- */
  // Preflight calls were billed too; let those charges land before measuring, or they would count as the run's.
  const preflightSpend = ctx.records.filter((r) => r.ok).reduce((sum, r) => sum + (r.expectedCost ?? 0n), 0n);
  await waitForCharges(ctx, balanceAtStart, preflightSpend);
  const before = await readBalance(client);
  if (before.available === null) throw new BenchError('Could not read your balance before the run.');
  const wait = createRateLimiter(rpm);
  let budgetStopped = false;

  /** Retry only rate-limit rejections (never billed); never retry a billed call. */
  const call = async (model, messages, tag, tokens) => {
    for (let attempt = 1; ; attempt++) {
      await wait();
      const rec = await probeChat(ctx, model, { messages, maxTokens: tokens, tag, keepContent: true });
      if (rec.status !== 429 || attempt >= 3) return rec;
      await sleep(1500 * attempt);
    }
  };

  // Item-major order: if the budget runs out, every model has the same completed prompts.
  const tasks = items.flatMap((item, index) => models.map((model) => ({ item, index, model })));
  /** @type {Map<string, import('../probe.js').CallRecord>} */
  const answers = new Map();
  let done = 0;
  await mapLimit(tasks, concurrency, async ({ item, model }) => {
    if (budgetStopped) return;
    try {
      const rec = await call(model, item.messages, 'shadow', item.maxTokens ?? maxTokens);
      answers.set(`${model.id}|${item.id}`, rec);
      if (onAnswer) {
        // Hard checks are instant, so show them live. A judged prompt is only "known wrong" if it already failed a hard check.
        const det = runChecks(item.expect, rec.ok ? rec.content ?? '' : null);
        try { onAnswer({ model: model.id, correct: item.judge ? (det.pass ? null : false) : det.pass }); } catch { /* a listener must not break the run */ }
      }
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      budgetStopped = true;
    }
    onProgress({ phase: 'shadow', done: ++done, total: tasks.length, message: `Shadow-running prompts (${done}/${tasks.length})` });
  });

  // Only prompts every model answered (or definitively failed) can be compared fairly.
  const complete = items.filter((it) => models.every((m) => answers.has(`${m.id}|${it.id}`)));
  if (complete.length < items.length) notes.push(`The spend cap stopped the run early: ${complete.length} of ${items.length} prompts were completed by every model, and only those are scored.`);
  if (!complete.length) throw new BenchError('The spend cap was reached before any prompt was completed by every model.');

  /* ---- 3. deterministic scoring ---- */
  /** @type {Map<string, {correct: number, reason: string|null}>} */
  const scored = new Map();
  for (const it of complete) {
    for (const m of models) {
      const rec = answers.get(`${m.id}|${it.id}`);
      const text = rec.ok ? rec.content ?? '' : null;
      const det = runChecks(it.expect, text);
      const failing = det.results.find((r) => !r.pass);
      scored.set(`${m.id}|${it.id}`, { correct: rec.ok && det.pass ? 1 : 0, reason: rec.ok ? (failing ? `${failing.name}: ${failing.detail}` : null) : `no answer (${clip(rec.error ?? '', 80)})` });
    }
  }

  /* ---- 4. pairwise judging, positions swapped ---- */
  const judgeStats = new Map(candidatesUsed.map((c) => [c.id, { model: judgeFor.get(c.id)?.id ?? null, pairs: 0, invalid: 0, positionBiased: 0 }]));
  const judgeTasks = [];
  for (const c of candidatesUsed) {
    for (const it of complete.filter((x) => x.judge)) {
      const ref = answers.get(`${currentModel.id}|${it.id}`);
      const cand = answers.get(`${c.id}|${it.id}`);
      // Nothing to compare if either side has no answer, or the candidate already failed a hard check.
      if (!ref.ok || !cand.ok || scored.get(`${c.id}|${it.id}`).correct === 0) continue;
      judgeTasks.push({ c, it, ref: ref.content ?? '', cand: cand.content ?? '' });
    }
  }
  let judgeDone = 0;
  await mapLimit(judgeTasks, concurrency, async ({ c, it, ref, cand }) => {
    if (budgetStopped) return;
    const j = judgeFor.get(c.id);
    const task = it.messages.map((m) => `[${m.role}] ${m.content}`).join('\n').slice(0, 4000);
    const rubric = it.judge.rubric;
    try {
      const [first, second] = await Promise.all([
        call(j, judgeMessages({ task, rubric, a: ref, b: cand }), 'judge', 40),
        call(j, judgeMessages({ task, rubric, a: cand, b: ref }), 'judge', 40),
      ]);
      const verdict = combineVerdicts(parseVerdict(first.content ?? null), parseVerdict(second.content ?? null));
      const stat = judgeStats.get(c.id);
      stat.pairs += 1;
      if (verdict.valid === 0) stat.invalid += 1;
      if (verdict.positionBiased) stat.positionBiased += 1;
      // A candidate is "as good" when it at least ties the current model overall. Unparseable verdicts count as ties.
      const score = verdict.score ?? 0.5;
      const key = `${c.id}|${it.id}`;
      const entry = scored.get(key);
      if (score < 0.5) scored.set(key, { correct: 0, reason: `judge preferred ${currentModel.id.split('/').pop()}` });
      else scored.set(key, entry);
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      budgetStopped = true;
    }
    onProgress({ phase: 'judge', done: ++judgeDone, total: judgeTasks.length, message: `Judging fuzzy answers (${judgeDone}/${judgeTasks.length})` });
  });
  if (budgetStopped && judgeDone < judgeTasks.length) notes.push('The spend cap stopped judging early; some fuzzy prompts were scored on hard checks only.');

  /* ---- 5. reconcile the whole benchmark against the balance ---- */
  onProgress({ phase: 'settle', message: 'Reconciling billing' });
  const after = await settleBalance(ctx, before);
  const paid = ctx.records.filter((r) => r.tag === 'shadow' || r.tag === 'judge');
  const reconciliation = evaluateBatch({ calls: paid, before, after, budgetStopped }, { tolerance: config.tolerance });

  /* ---- 6. statistics ---- */
  const currentVec = complete.map((it) => scored.get(`${currentModel.id}|${it.id}`).correct);
  /** @type {import('./recommend.js').ModelStats[]} */
  const stats = [];
  const detail = [];
  for (const m of models) {
    const isCurrent = m.id === currentModel.id;
    const vec = complete.map((it) => scored.get(`${m.id}|${it.id}`).correct);
    const recs = complete.map((it) => answers.get(`${m.id}|${it.id}`));
    const okRecs = recs.filter((r) => r.ok);
    const totalCost = okRecs.reduce((s, r) => s + (r.expectedCost ?? 0n), 0n);
    const k = vec.reduce((a, b) => a + b, 0);
    const n = vec.length;
    const paired = isCurrent ? null : bootstrapPaired(currentVec, vec, { seed: 11 });
    const costPer1k = (num(totalCost) / n) * 1000;
    const acc = wilson(k, n);
    stats.push({
      id: m.id, isCurrent, costPer1k, n, accuracy: k / n,
      diff: paired && Number.isFinite(paired.diff.est) ? paired.diff : null, diffSd: paired?.diffSd ?? null,
      costPerCorrect: k > 0 ? costPer1k / (k / n) : null, errorRate: (n - okRecs.length) / n,
    });
    // An empty or cut-off answer scores as wrong. Reasoning models can spend the whole token limit on
    // hidden thinking, which would make a good cheap model look bad, so count and say so.
    const cutOff = okRecs.filter((r) => r.finishReason === 'length' || !(r.content ?? '').trim()).length;
    if (cutOff / n >= 0.1) {
      notes.push(`${m.id}: ${cutOff} of ${n} answers were empty or cut off at the ${maxTokens}-token limit, and were scored as wrong. Reasoning models can spend the limit on hidden thinking; raise --max-tokens before trusting this result.`);
    }
    const latencies = okRecs.map((r) => r.latencyMs);
    const failures = complete
      .filter((it) => scored.get(`${m.id}|${it.id}`).correct === 0)
      .slice(0, 3)
      .map((it) => ({ id: it.id, prompt: clip(lastUser(it), 140), answer: clip(answers.get(`${m.id}|${it.id}`).content ?? '', 160), reason: scored.get(`${m.id}|${it.id}`).reason }));
    detail.push({
      id: m.id, role: isCurrent ? 'current' : 'candidate',
      totalCostUsd: formatDecimal(totalCost, 9), correct: k, n, cutOff,
      accuracyCi: [acc.lo, acc.hi],
      qualityVsCurrent: paired && Number.isFinite(paired.ratio.est) ? paired.ratio : isCurrent ? { est: 1, lo: 1, hi: 1 } : null,
      latencyP50Ms: Math.round(percentile(latencies, 50)) || null, latencyP95Ms: Math.round(percentile(latencies, 95)) || null,
      avgPromptTokens: okRecs.length ? Math.round(okRecs.reduce((s, r) => s + (r.promptTokens ?? 0), 0) / okRecs.length) : null,
      avgCompletionTokens: okRecs.length ? Math.round(okRecs.reduce((s, r) => s + (r.completionTokens ?? 0), 0) / okRecs.length) : null,
      judge: isCurrent ? null : judgeStats.get(m.id)?.pairs ? judgeStats.get(m.id) : null,
      failures: samples ? failures : [],
    });
  }

  const rec = recommend(stats, { marginPts, minSamples, minSavings });
  const words = describe(rec, stats);
  const finished = new Date();
  const currentStats = stats[0];
  const judgeCostUsd = ctx.records.filter((r) => r.tag === 'judge').reduce((s, r) => s + (r.expectedCost ?? 0n), 0n);

  const models_out = stats.map((s, i) => ({
    ...detail[i],
    costPer1kUsd: s.costPer1k,
    accuracy: s.accuracy,
    diff: s.diff,
    diffSd: s.diffSd,
    costPerCorrect1kUsd: s.costPerCorrect,
    savings: s.isCurrent ? 0 : currentStats.costPer1k > 0 ? 1 - s.costPer1k / currentStats.costPer1k : 0,
    errorRate: s.errorRate,
    verdict: s.isCurrent ? 'current' : rec.perModel[s.id].verdict,
    neededSamples: s.isCurrent ? null : rec.perModel[s.id].neededSamples,
  }));

  return {
    report: {
      schema: 'assay.bench/1',
      id: started.toISOString().replace(/[:.]/g, '-'),
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      tool: { name: 'assay', version: VERSION },
      gateway: { host: new URL(config.baseUrl).host },
      dataset: { name: datasetName, prompts: complete.length, requested: items.length, judged: complete.filter((it) => it.judge).length },
      settings: { current: currentModel.id, marginPts, minSamples, minSavings, maxTokens },
      // The integration: every benchmark states how far to trust the gateway it ran on.
      trust: {
        audit: auditSummary,
        billing: {
          verdict: reconciliation.verdict, ratio: reconciliation.ratio, calls: reconciliation.calls,
          billedUsd: formatDecimal(reconciliation.billed, 9), expectedUsd: formatDecimal(reconciliation.expected, 9),
        },
      },
      models: models_out,
      recommendation: {
        action: rec.action, model: rec.model, savings: rec.savings, marginPts: rec.marginPts, neededSamples: rec.neededSamples ?? null,
        headline: words.headline, detail: words.detail,
        configChange: rec.action === 'keep' ? null : { from: currentModel.id, to: rec.model },
      },
      spend: {
        calls: paid.length,
        expectedUsd: formatDecimal(paid.reduce((s, r) => s + (r.expectedCost ?? 0n), 0n), 9),
        judgeUsd: formatDecimal(judgeCostUsd, 9),
        actualUsd: formatDecimal((before.available ?? 0n) - (after.available ?? 0n), 9),
        capUsd: formatDecimal(config.maxSpend, 6),
        partial: budgetStopped,
      },
      skipped,
      notes,
    },
    plan,
  };
}
