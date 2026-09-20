import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatDecimal } from './decimal.js';

/** JSON.stringify replacer: scaled decimals (bigint) become exact strings. */
export const bigintReplacer = (_key, value) => (typeof value === 'bigint' ? formatDecimal(value, 9) : value);

/** @param {string} path @param {unknown} data */
function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, bigintReplacer, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Filesystem store under `.assay/`: every report, the latest one, a one-line-per-run history,
 * and a catalog snapshot so the estimator works offline.
 * @param {string} dir
 */
export function createStore(dir) {
  const reports = join(dir, 'reports');
  const ensure = () => mkdirSync(reports, { recursive: true, mode: 0o700 });

  return {
    dir,

    /** @param {any} report @returns {string} path of the saved report */
    saveReport(report) {
      ensure();
      const path = join(reports, `${report.id}.json`);
      writeJsonAtomic(path, report);
      writeJsonAtomic(join(dir, 'latest.json'), report);
      const line = {
        id: report.id,
        at: report.finishedAt,
        fineness: report.score.fineness,
        grade: report.score.grade,
        coverage: report.score.coverage,
        statuses: Object.fromEntries(report.checks.map((c) => [c.id, c.status])),
      };
      appendFileSync(join(dir, 'history.jsonl'), `${JSON.stringify(line)}\n`);
      return path;
    },

    loadLatest() {
      return readJson(join(dir, 'latest.json'));
    },

    /** @param {number} [limit] */
    loadHistory(limit = 60) {
      const file = join(dir, 'history.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-limit);
    },

    listReports() {
      return existsSync(reports) ? readdirSync(reports).filter((f) => f.endsWith('.json')).sort() : [];
    },

    /** @param {any} report @returns {string} path of the saved benchmark */
    saveBench(report) {
      mkdirSync(join(dir, 'bench'), { recursive: true, mode: 0o700 });
      const path = join(dir, 'bench', `${report.id}.json`);
      writeJsonAtomic(path, report);
      writeJsonAtomic(join(dir, 'bench-latest.json'), report);
      appendFileSync(join(dir, 'bench-history.jsonl'), `${JSON.stringify({
        id: report.id, at: report.finishedAt, dataset: report.dataset.name, action: report.recommendation.action,
        current: report.settings.current, model: report.recommendation.model, savings: report.recommendation.savings,
      })}\n`);
      return path;
    },

    loadLatestBench() {
      return readJson(join(dir, 'bench-latest.json'));
    },

    /**
     * Save prices as decimal strings in USD per token.
     * @param {{host:string, priceUnit:string}} meta
     * @param {import('./catalog.js').CatalogModel[]} models
     */
    saveCatalog(meta, models) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(join(dir, 'catalog.json'), {
        savedAt: new Date().toISOString(),
        host: meta.host,
        models: models
          .filter((m) => m.promptPrice !== null && m.completionPrice !== null)
          .map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, promptPrice: formatDecimal(m.promptPrice, 15), completionPrice: formatDecimal(m.completionPrice, 15) })),
      });
    },

    loadCatalog() {
      return readJson(join(dir, 'catalog.json'));
    },
  };
}
