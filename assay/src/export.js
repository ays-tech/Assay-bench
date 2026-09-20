import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

/**
 * Drop ES-module syntax so two modules can share one classic <script> scope.
 * Deliberately narrow: it only handles the forms the web/ sources actually use, and the
 * export test fails loudly if that ever stops being true.
 * @param {string} source
 */
export function stripModuleSyntax(source) {
  return source
    .replace(/^import\s[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/^export\s+/gm, '');
}

/** Safe to embed inside <script type="application/json">. @param {unknown} value */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Build one self-contained HTML file: styles, script, and the report data inlined.
 * Opens from disk with no server; fonts fall back to system fonts when offline.
 *
 * @param {{report: any, bench?: any, history?: any[], catalog?: any[], webDir?: string, public?: boolean}} opts
 * @returns {string}
 */
export function buildStaticHtml({ report, bench = null, history = [], catalog = [], webDir = WEB_DIR, public: isPublic = false }) {
  const read = (name) => readFileSync(join(webDir, name), 'utf8');
  let html = read('index.html');
  const css = read('app.css');
  // One classic <script> scope, in dependency order.
  const script = `(() => {\n${['dom.js', 'pricing.js', 'recommend.js', 'bench-view.js', 'home-view.js', 'activity-view.js', 'app.js'].map((f) => stripModuleSyntax(read(f))).join('\n')}\n})();`;

  const safeReport = report ? { ...report } : null;
  if (safeReport && isPublic) delete safeReport.keyFingerprint;
  // Excerpts of the model's answers can contain your prompts' content; a public scorecard drops them.
  const safeBench = bench ? { ...bench, models: bench.models.map((m) => (isPublic ? { ...m, failures: [] } : m)) } : null;
  const data = { report: safeReport, bench: safeBench, history, catalog, canRun: false, canBench: false, datasets: [], static: true, generatedAt: new Date().toISOString() };

  html = html
    .replace('<link rel="stylesheet" href="/assets/app.css">', () => `<style>\n${css}\n</style>`)
    .replace('<script type="module" src="/assets/app.js"></script>', () =>
      `<script id="assay-data" type="application/json">${jsonForScript(data)}</script>\n<script>\n${script.replace(/<\/script/gi, '<\\/script')}\n</script>`);
  return html;
}
