import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPriced } from './estimate/index.js';
import { BenchError } from './bench/run.js';
import { listDatasets, validateBenchParams } from './bench/service.js';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const CATALOG_TTL_MS = 5 * 60_000;

/** No inline script, no third-party script; fonts are the only external origin. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Hosts we answer to. Rejecting anything else defeats DNS-rebinding: a hostile page cannot
 * make the browser talk to this server under its own domain name.
 * @param {string|undefined} host
 */
export function isAllowedHost(host) {
  if (!host) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

/**
 * @typedef {object} DashboardOptions
 * @property {ReturnType<import('./store.js').createStore>} store
 * @property {((onProgress: (e: any) => void) => Promise<{report:any, catalog:any}>)|null} [runner]  starts an audit; null disables the Run button
 * @property {((params: any, onProgress: (e: any) => void) => Promise<{report: any}>)|null} [benchRunner]  runs (and saves) a benchmark; null disables it
 * @property {(() => Promise<any[]|null>)|null} [liveCatalog]  fetches priced models from the gateway
 * @property {string} [webDir]
 */

/**
 * Local dashboard: static assets plus a tiny JSON API. The gateway key never leaves this process.
 * @param {DashboardOptions} opts
 */
export function createDashboardServer({ store, runner = null, benchRunner = null, liveCatalog = null, webDir = WEB_DIR }) {
  const run = { running: false, message: 'Idle', phase: 'idle', error: /** @type {string|null} */ (null), startedAt: /** @type {number|null} */ (null) };
  const bench = { running: false, phase: 'idle', message: 'Idle', done: 0, total: 0, error: /** @type {string|null} */ (null) };
  let catalogCache = /** @type {{at:number, models:any[]}|null} */ (null);

  async function getCatalog() {
    if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
    if (liveCatalog) {
      try {
        const models = await liveCatalog();
        if (models?.length) {
          catalogCache = { at: Date.now(), models };
          return models;
        }
      } catch {
        /* fall back to the stored snapshot */
      }
    }
    const snap = store.loadCatalog();
    return snap ? toPriced(snap.models) : [];
  }

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  /** Read a small JSON body; refuse anything large or malformed. @param {import('node:http').IncomingMessage} req */
  const readJson = (req, limit = 4096) =>
    new Promise((resolveBody, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reject(new BenchError('Invalid request: content type must be application/json'));
      let size = 0;
      let refused = false;
      const chunks = [];
      req.on('data', (c) => {
        if (refused) return; // keep draining so the client can still receive our 400
        size += c.length;
        if (size > limit) {
          refused = true;
          chunks.length = 0;
          reject(new BenchError('Invalid request: body too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (refused) return;
        try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new BenchError('Invalid request: body is not JSON')); }
      });
      req.on('error', reject);
    });

  async function serveAsset(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/assets\//, '');
    const target = normalize(join(webDir, rel));
    if (target !== webDir && !target.startsWith(webDir + sep)) return send(res, 403, { error: 'forbidden' });
    try {
      const data = await readFile(target);
      return send(res, 200, data, MIME[extname(target)] ?? 'application/octet-stream');
    } catch {
      return send(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host)) return send(res, 403, { error: 'host not allowed' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (req.method === 'POST') {
        // Same-origin only: browsers always send Origin on cross-site POSTs.
        const origin = req.headers.origin;
        if (origin) {
          // "null" (sandboxed iframes, some redirects) is not a URL and is certainly not the dashboard.
          let originHost = null;
          try { originHost = new URL(origin).host; } catch { /* treated as foreign */ }
          if (originHost !== req.headers.host) return send(res, 403, { error: 'cross-origin request blocked' });
        }
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, {
          report: store.loadLatest(), history: store.loadHistory(), catalog: await getCatalog(), canRun: Boolean(runner),
          bench: store.loadLatestBench(), canBench: Boolean(benchRunner), datasets: listDatasets(store.dir).map(({ id, label, prompts }) => ({ id, label, prompts })),
        });
      }
      if (url.pathname === '/api/bench/run' && req.method === 'POST') {
        if (!benchRunner) return send(res, 501, { error: 'No API key configured. Set ORBIO_API_KEY and restart `assay serve`.' });
        let params;
        try {
          params = validateBenchParams(await readJson(req));
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        if (bench.running) return send(res, 409, { error: 'A benchmark is already running.' });
        Object.assign(bench, { running: true, error: null, phase: 'plan', message: 'Planning', done: 0, total: 0 });
        benchRunner(params, (e) => Object.assign(bench, { phase: e.phase, message: e.message, done: e.done ?? bench.done, total: e.total ?? bench.total }))
          .then(() => Object.assign(bench, { running: false, phase: 'done', message: 'Benchmark complete' }))
          .catch((err) => Object.assign(bench, { running: false, phase: 'error', message: 'Benchmark failed', error: String(err?.message ?? err) }));
        return send(res, 202, { started: true });
      }
      if (url.pathname === '/api/bench/status' && req.method === 'GET') return send(res, 200, bench);
      if (url.pathname === '/api/run' && req.method === 'POST') {
        if (!runner) return send(res, 501, { error: 'No API key configured. Set ORBIO_API_KEY and restart `assay serve`.' });
        if (run.running) return send(res, 409, { error: 'An audit is already running.' });
        Object.assign(run, { running: true, error: null, startedAt: Date.now(), phase: 'start', message: 'Starting audit' });
        runner((e) => Object.assign(run, { phase: e.phase, message: e.message }))
          .then(({ report, catalog }) => {
            store.saveReport(report);
            if (catalog) store.saveCatalog({ host: report.gateway.host, priceUnit: catalog.priceUnit }, catalog.models);
            catalogCache = null;
            Object.assign(run, { running: false, phase: 'done', message: 'Audit complete' });
          })
          .catch((err) => Object.assign(run, { running: false, phase: 'error', message: 'Audit failed', error: String(err?.message ?? err) }));
        return send(res, 202, { started: true });
      }
      if (url.pathname === '/api/run/status' && req.method === 'GET') return send(res, 200, run);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) return serveAsset(res, url.pathname);
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: 'internal error' });
    }
  });

  return {
    server,
    /** @param {number} port @param {string} [host] */
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolveListen(/** @type {import('node:net').AddressInfo} */ (server.address())));
      }),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }),
  };
}
