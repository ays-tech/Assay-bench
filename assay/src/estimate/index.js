import { resolve } from 'node:path';
import { resolveModel, scanRepo } from './scan.js';
import { BOOK_SNAPSHOT, estimateWorkload, HEADLINE_DISCOUNT, PLATFORM_FEE, netSaving } from '../../web/pricing.js';
import { toNumber } from '../decimal.js';

export { BOOK_SNAPSHOT, HEADLINE_DISCOUNT, PLATFORM_FEE, netSaving };

/**
 * Catalog entries as plain numbers (USD per token), from either a live normalised catalog
 * (bigint prices) or a stored snapshot (decimal strings).
 * @param {Array<{id:string,name?:string,promptPrice:any,completionPrice:any}>} models
 */
export function toPriced(models) {
  const num = (v) => (typeof v === 'bigint' ? toNumber(v) : Number(v));
  return models
    .filter((m) => m.promptPrice !== null && m.completionPrice !== null)
    .map((m) => ({ id: m.id, name: m.name ?? m.id, promptPrice: num(m.promptPrice), completionPrice: num(m.completionPrice) }));
}

/**
 * Scan a repo, match what it uses to the catalog, and price it.
 *
 * Volume is what the code cannot tell us, so it comes from the caller and is split across
 * the detected models in proportion to how often each is referenced.
 *
 * @param {object} opts
 * @param {string} opts.path
 * @param {ReturnType<typeof toPriced>} opts.catalog
 * @param {number} [opts.inputMtok]   total million input tokens / month
 * @param {number} [opts.outputMtok]  total million output tokens / month
 * @param {number} [opts.discount]    fraction
 * @param {number} [opts.fee]         fraction
 * @param {boolean} [opts.book]       blend the discount from the liquidity book snapshot
 */
export function estimateRepo({ path, catalog, inputMtok, outputMtok, discount = HEADLINE_DISCOUNT, fee = PLATFORM_FEE, book = false }) {
  const root = resolve(path);
  const vendors = new Set(catalog.map((m) => m.id.split('/')[0]));
  const scan = scanRepo(root, { knownVendors: vendors });

  /** @type {Map<string, {id:string, name:string, promptPrice:number, completionPrice:number, refs:number, from:string[]}>} */
  const matched = new Map();
  const unmatched = [];
  for (const [raw, info] of scan.models) {
    const hit = resolveModel(raw, catalog);
    if (!hit) {
      unmatched.push({ raw, refs: info.count });
      continue;
    }
    const cur = matched.get(hit.id) ?? { ...hit, refs: 0, from: [] };
    cur.refs += info.count;
    cur.from.push(raw);
    matched.set(hit.id, cur);
  }
  const models = [...matched.values()].sort((a, b) => b.refs - a.refs);

  const hasVolume = Number.isFinite(inputMtok) || Number.isFinite(outputMtok);
  let estimate = null;
  if (hasVolume && models.length) {
    const totalRefs = models.reduce((s, m) => s + m.refs, 0);
    const rows = models.map((m) => ({
      id: m.id, promptPrice: m.promptPrice, completionPrice: m.completionPrice,
      inputMtok: ((inputMtok ?? 0) * m.refs) / totalRefs,
      outputMtok: ((outputMtok ?? 0) * m.refs) / totalRefs,
    }));
    estimate = estimateWorkload(rows, { discount, fee, book: book ? BOOK_SNAPSHOT.tiers : null });
  }

  return {
    path: root,
    filesScanned: scan.filesScanned,
    endpoints: scan.endpoints,
    envVars: scan.envVars,
    models,
    unmatched: unmatched.sort((a, b) => b.refs - a.refs),
    assumptions: { discount, fee, book, netSaving: netSaving(discount, fee), bookSnapshot: book ? BOOK_SNAPSHOT.takenAt : null, volumeSplit: 'proportional to code references' },
    estimate,
  };
}

/**
 * The migration is two lines. Show them, per endpoint found, without touching any file.
 * @param {ReturnType<typeof estimateRepo>['endpoints']} endpoints
 * @param {string} orbioBase
 */
export function migrationHints(endpoints, orbioBase) {
  return endpoints.map((e) => ({ file: e.file, line: e.line, from: e.match, to: orbioBase, note: e.note }));
}
