import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../store.js';
import { parseDecimal } from '../decimal.js';
import { loadDataset } from './dataset.js';
import { BenchError, runBench } from './run.js';

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples');
export const SAMPLE_PATH = join(EXAMPLES, 'support-tickets.jsonl');

const countLines = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).length;

/**
 * Datasets the dashboard may offer. The server chooses the path, never the client, so the API
 * cannot be used to read arbitrary files.
 * @param {string} dir the .assay directory
 * @returns {Array<{id: string, label: string, prompts: number, path: string}>}
 */
export function listDatasets(dir) {
  const out = [];
  if (existsSync(SAMPLE_PATH)) out.push({ id: 'sample', label: 'Support tickets (sample)', prompts: countLines(SAMPLE_PATH), path: SAMPLE_PATH });
  const own = join(dir, 'datasets');
  if (existsSync(own)) {
    for (const file of readdirSync(own).filter((f) => f.endsWith('.jsonl')).sort()) {
      out.push({ id: `file:${basename(file)}`, label: basename(file, '.jsonl'), prompts: countLines(join(own, file)), path: join(own, file) });
    }
  }
  return out;
}

/** The latest Assay audit, as trust context for a benchmark run on the same gateway. */
export function auditSummaryFor(store, host) {
  const audit = store.loadLatest();
  if (!audit || audit.gateway?.host !== host) return null;
  return { id: audit.id, fineness: audit.score.fineness, grade: audit.score.grade, coverage: audit.score.coverage, at: audit.finishedAt, headline: audit.headline };
}

const MODEL_ID = /^[A-Za-z0-9][\w.\-:/]{0,120}$/;

/**
 * Validate parameters that arrive over HTTP. Everything is checked; nothing is trusted.
 * @param {any} body
 */
export function validateBenchParams(body) {
  const fail = (m) => { throw new BenchError(`Invalid request: ${m}`); };
  if (!body || typeof body !== 'object') fail('expected a JSON object');
  const dataset = String(body.dataset ?? 'sample');
  const current = String(body.current ?? '').trim();
  if (!MODEL_ID.test(current)) fail('"current" must be a model id such as provider/model');

  let candidates = 'auto';
  if (Array.isArray(body.candidates)) {
    if (body.candidates.length < 1 || body.candidates.length > 8) fail('"candidates" must list 1 to 8 models, or be "auto"');
    candidates = body.candidates.map(String).map((s) => s.trim());
    if (!candidates.every((c) => MODEL_ID.test(c))) fail('"candidates" contains an invalid model id');
  } else if (body.candidates !== undefined && body.candidates !== 'auto') fail('"candidates" must be "auto" or a list');

  const bounded = (key, lo, hi, fallback) => {
    if (body[key] === undefined || body[key] === '') return fallback;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < lo || n > hi) fail(`"${key}" must be between ${lo} and ${hi}`);
    return n;
  };
  return {
    dataset, current, candidates,
    limit: body.limit === undefined || body.limit === '' ? undefined : Math.round(bounded('limit', 5, 1000, 0)),
    marginPts: bounded('marginPts', 1, 30, 5),
    maxSpend: bounded('maxSpend', 0.01, 5, 1),
  };
}

/**
 * Run one benchmark end to end and persist it. Shared by `assay bench` and the dashboard.
 *
 * @param {object} opts
 * @param {import('../config.js').Config} opts.config
 * @param {import('../client.js').OrbioClient} opts.client
 * @param {ReturnType<typeof createStore>} opts.store
 * @param {any} opts.params validated bench parameters
 * @param {import('./dataset.js').BenchItem[]} [opts.dataset] supply items directly (CLI --data)
 * @param {string} [opts.datasetName]
 * @param {(e: any) => void} [opts.onProgress]
 * @param {Function} [opts.onCall] @param {Function} [opts.onAnswer] live-activity hooks
 */
export async function runBenchJob({ config, client, store, params, dataset, datasetName, onProgress, onCall, onAnswer }) {
  let items = dataset;
  let name = datasetName;
  if (!items) {
    const chosen = listDatasets(store.dir).find((d) => d.id === params.dataset);
    if (!chosen) throw new BenchError(`Unknown dataset "${params.dataset}".`);
    items = loadDataset(chosen.path);
    name = chosen.label;
  }
  const cfg = { ...config, maxSpend: parseDecimal(String(params.maxSpend ?? '1')) };
  const host = new URL(config.baseUrl).host;
  const result = await runBench({
    config: cfg, client, dataset: items, datasetName: name ?? 'dataset',
    current: params.current, candidates: params.candidates ?? 'auto', judge: params.judge ?? null,
    limit: params.limit, maxTokens: params.maxTokens, marginPts: params.marginPts ?? 5,
    concurrency: params.concurrency, rpm: params.rpm, samples: params.samples !== false, dryRun: Boolean(params.dryRun),
    auditSummary: auditSummaryFor(store, host), onProgress, onCall, onAnswer,
  });
  if (result.report) result.savedPath = store.saveBench(result.report);
  return result;
}
