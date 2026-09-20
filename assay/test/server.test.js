import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer, isAllowedHost, CSP } from '../src/server.js';
import { createStore } from '../src/store.js';
import { buildStaticHtml, stripModuleSyntax, jsonForScript } from '../src/export.js';
import { auditMock } from './helpers.js';
import { toPriced } from '../src/estimate/index.js';

/** Raw request so we can forge the Host header, which fetch() forbids. */
function raw(port, { path = '/', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(opts, fn) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'assay-srv-')));
  const dash = createDashboardServer({ store, ...opts });
  const { port } = await dash.listen(0);
  try {
    await fn({ port, store });
  } finally {
    await dash.close();
  }
}

test('host allow-list accepts only loopback names', () => {
  for (const ok of ['localhost:4477', '127.0.0.1:1', '[::1]:9', 'localhost']) assert.equal(isAllowedHost(ok), true, ok);
  for (const bad of ['evil.com', 'localhost.evil.com', '127.0.0.1.evil.com:80', '', undefined, '10.0.0.5:4477']) assert.equal(isAllowedHost(bad), false, String(bad));
});

test('serves the app with a strict CSP and rejects DNS-rebinding hosts', async () => {
  await withServer({}, async ({ port }) => {
    const ok = await raw(port, { path: '/', headers: { Host: `localhost:${port}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-security-policy'], CSP);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(ok.headers['content-security-policy']));
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.match(ok.body, /<title>Assay/);

    const rebound = await raw(port, { path: '/api/state', headers: { Host: 'attacker.example' } });
    assert.equal(rebound.status, 403);
  });
});

test('static routes cannot escape the web directory', async () => {
  await withServer({}, async ({ port }) => {
    for (const path of ['/assets/../package.json', '/assets/..%2fpackage.json', '/assets/../../etc/passwd', '/assets/%2e%2e/%2e%2e/etc/passwd']) {
      const r = await raw(port, { path, headers: { Host: `localhost:${port}` } });
      assert.ok([403, 404].includes(r.status), `${path} → ${r.status}`);
      assert.ok(!r.body.includes('"name": "assay"') && !r.body.includes('root:'), path);
    }
    const asset = await raw(port, { path: '/assets/app.css', headers: { Host: `localhost:${port}` } });
    assert.equal(asset.status, 200);
    assert.match(asset.headers['content-type'], /text\/css/);
  });
});

test('cross-origin POST /api/run is refused; without a runner it is 501', async () => {
  let started = 0;
  await withServer({ runner: async () => { started++; return { report: null, catalog: null }; } }, async ({ port }) => {
    const cross = await raw(port, { path: '/api/run', method: 'POST', headers: { Host: `localhost:${port}`, Origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    assert.equal(started, 0, 'a hostile page must not be able to spend credit');
  });
  await withServer({}, async ({ port }) => {
    const r = await raw(port, { path: '/api/run', method: 'POST', headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
    assert.equal(r.status, 501);
    assert.match(JSON.parse(r.body).error, /ORBIO_API_KEY/);
  });
});

test('run flow: start, poll, saved, and a second start while running is 409', async () => {
  const { report, catalog } = await auditMock();
  let release;
  const gate = new Promise((r) => (release = r));
  await withServer({ runner: async (onProgress) => { onProgress({ phase: 'check', message: 'Checking: billing' }); await gate; return { report, catalog }; } }, async ({ port, store }) => {
    const h = { Host: `localhost:${port}`, Origin: `http://localhost:${port}` };
    assert.equal((await raw(port, { path: '/api/run', method: 'POST', headers: h })).status, 202);
    assert.equal((await raw(port, { path: '/api/run', method: 'POST', headers: h })).status, 409);
    const mid = JSON.parse((await raw(port, { path: '/api/run/status', headers: h })).body);
    assert.equal(mid.running, true);
    assert.match(mid.message, /billing/);

    release();
    for (let i = 0; i < 50; i++) {
      const st = JSON.parse((await raw(port, { path: '/api/run/status', headers: h })).body);
      if (!st.running) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const state = JSON.parse((await raw(port, { path: '/api/state', headers: h })).body);
    assert.equal(state.report.schema, 'assay.report/1');
    assert.equal(state.canRun, true);
    assert.ok(state.catalog.length > 0, 'catalog snapshot saved by the run is served to the estimator');
    assert.equal(store.loadHistory().length, 1);
  });
});

test('a failing runner surfaces its error and unlocks the button', async () => {
  await withServer({ runner: async () => { throw new Error('boom'); } }, async ({ port }) => {
    const h = { Host: `localhost:${port}`, Origin: `http://localhost:${port}` };
    await raw(port, { path: '/api/run', method: 'POST', headers: h });
    await new Promise((r) => setTimeout(r, 60));
    const st = JSON.parse((await raw(port, { path: '/api/run/status', headers: h })).body);
    assert.equal(st.running, false);
    assert.equal(st.error, 'boom');
  });
});

/* ---------- static export ---------- */

test('export bundle is valid classic JavaScript with no module syntax left', async () => {
  const { report } = await auditMock();
  const html = buildStaticHtml({ report, history: [], catalog: [] });
  const scripts = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0], /^\s*(import|export)\s/m);
  assert.doesNotThrow(() => new Function(scripts[0]), 'bundled script must parse');
  assert.ok(!html.includes('href="/assets/'), 'no reference to server assets');
});

test('export embeds data safely: </script> and HTML in report text cannot break out', async () => {
  const { report } = await auditMock();
  const hostile = { ...report, headline: '</script><img src=x onerror=alert(1)>', keyFingerprint: 'abc12345' };
  const html = buildStaticHtml({ report: hostile, public: true });
  assert.ok(!html.includes('</script><img'), 'closing tag must be escaped inside JSON');
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('abc12345'), '--public drops the fingerprint');
  assert.equal(jsonForScript({ a: '<!--' }), '{"a":"\\u003c!--"}');
});

test('stripModuleSyntax handles the forms the web sources use', () => {
  const src = "import {\n  a,\n  b,\n} from './x.js';\nexport const c = 1;\nexport function d() {}\nexport default 5;\nconst e = 'import x from y';";
  const out = stripModuleSyntax(src);
  assert.doesNotMatch(out, /^import/m);
  assert.match(out, /^const c = 1;/m);
  assert.match(out, /^function d\(\)/m);
  assert.match(out, /'import x from y'/, 'string contents are untouched');
});

/* ---------- bench endpoints ---------- */

const post = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timed out'); };
const sampleReport = { id: 'b1', schema: 'assay.bench/1', settings: { current: 'a/b', marginPts: 5 }, dataset: { name: 'x' }, recommendation: { action: 'keep', model: 'a/b', savings: 0 }, finishedAt: new Date().toISOString(), models: [] };

test('state reports whether benchmarking is available and which datasets the server itself offers', async () => {
  await withServer({}, async ({ port }) => {
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.canBench, false);
    assert.equal(state.bench, null);
    assert.deepEqual(state.datasets.map((d) => d.id), ['sample']);
    assert.ok(!('path' in state.datasets[0]), 'the client is never told a file path');
  });
  await withServer({ benchRunner: async () => ({}) }, async ({ port, store }) => {
    store.saveBench(sampleReport);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.canBench, true);
    assert.equal(state.bench.id, 'b1');
  });
});

test('POST /api/bench/run: no key configured is 501, and bad input is a readable 400 that never reaches the runner', async () => {
  let calls = 0;
  await withServer({}, async ({ port }) => {
    assert.equal((await post(port, '/api/bench/run', { current: 'a/b' })).status, 501);
  });
  await withServer({ benchRunner: async () => { calls++; return {}; } }, async ({ port }) => {
    for (const body of [{}, { current: '' }, { current: 'x y; rm -rf' }, { current: '../../etc/passwd' }, { current: 'a/b', candidates: 'everything' },
      { current: 'a/b', candidates: ['ok/one', 'bad one'] }, { current: 'a/b', marginPts: 500 }, { current: 'a/b', maxSpend: 1000 }, { current: 'a/b', limit: 1 }, '{not json', '[]']) {
      const res = await post(port, '/api/bench/run', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, /Invalid request/);
    }
    const oversized = await post(port, '/api/bench/run', JSON.stringify({ current: 'a/b', pad: 'x'.repeat(10_000) }));
    assert.equal(oversized.status, 400);
    assert.equal(calls, 0);
  });
});

test('POST /api/bench/run is loopback-only, same-origin and JSON only, like every other state-changing route', async () => {
  let calls = 0;
  await withServer({ benchRunner: async () => { calls++; return {}; } }, async ({ port }) => {
    const cross = await post(port, '/api/bench/run', { current: 'a/b' }, { Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const sandboxed = await post(port, '/api/bench/run', { current: 'a/b' }, { Origin: 'null' }); // sandboxed iframes and some redirects send this
    assert.equal(sandboxed.status, 403, 'an opaque origin is not the dashboard');

    // fetch() will not forge Host, so use a raw request (DNS rebinding)
    const rebinding = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ current: 'a/b' });
      const req = http.request({ host: '127.0.0.1', port, path: '/api/bench/run', method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(rebinding, 403);

    const wrongType = await post(port, '/api/bench/run', '{"current":"a/b"}', { 'Content-Type': 'text/plain' });
    assert.equal(wrongType.status, 400);
    assert.match((await wrongType.json()).error, /application\/json/);
    assert.equal(calls, 0, 'none of these may spend money');
  });
});

test('a valid run starts, reports progress, refuses a second concurrent run, and surfaces failures', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const seen = [];
  await withServer({ benchRunner: async (params, onProgress) => { seen.push(params); onProgress({ phase: 'shadow', done: 3, total: 10, message: 'Shadow-running prompts (3/10)' }); await gate; } }, async ({ port }) => {
    const ok = await post(port, '/api/bench/run', { current: 'openai/gpt-6-astra', candidates: ['a/b', 'c/d'], marginPts: 10, limit: 20, maxSpend: 0.5 });
    assert.equal(ok.status, 202);
    const status = await until(async () => { const s = await (await fetch(`http://127.0.0.1:${port}/api/bench/status`)).json(); return s.done === 3 ? s : null; });
    assert.equal(status.running, true);
    assert.equal(status.total, 10);
    assert.equal((await post(port, '/api/bench/run', { current: 'openai/gpt-6-astra' })).status, 409);
    release();
    await until(async () => !(await (await fetch(`http://127.0.0.1:${port}/api/bench/status`)).json()).running);
    assert.deepEqual(seen[0], { dataset: 'sample', current: 'openai/gpt-6-astra', candidates: ['a/b', 'c/d'], limit: 20, marginPts: 10, maxSpend: 0.5 });
  });

  await withServer({ benchRunner: async () => { throw new Error('gateway said no'); } }, async ({ port }) => {
    await post(port, '/api/bench/run', { current: 'a/b' });
    const failed = await until(async () => { const s = await (await fetch(`http://127.0.0.1:${port}/api/bench/status`)).json(); return s.phase === 'error' ? s : null; });
    assert.equal(failed.running, false);
    assert.match(failed.error, /gateway said no/);
    assert.equal((await post(port, '/api/bench/run', { current: 'a/b' })).status, 202, 'a failure does not wedge the server');
  });
});

test('static export embeds the benchmark, bundles every module, and a public export drops answer excerpts', () => {
  const bench = { ...sampleReport, models: [{ id: 'a/b', role: 'current', failures: [{ id: 'q1', prompt: 'secret customer text', answer: 'x', reason: 'r' }] }] };
  const html = buildStaticHtml({ report: null, bench });
  const data = JSON.parse(/<script id="assay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.bench.id, 'b1');
  assert.equal(data.canBench, false);
  assert.equal(data.bench.models[0].failures.length, 1, 'a private export keeps them');
  const pub = JSON.parse(/<script id="assay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(buildStaticHtml({ report: null, bench, public: true }))[1]);
  assert.deepEqual(pub.bench.models[0].failures, []);
  assert.ok(!buildStaticHtml({ report: null, bench, public: true }).includes('secret customer text'));

  // the bundle must parse as one classic script: no import/export left, no duplicate top-level names
  const script = /<script>\n([\s\S]*)\n<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Function(script), 'bundle is valid JavaScript');
  assert.ok(!/^\s*(import|export)\s/m.test(script), 'no module syntax left');
  for (const marker of ['function renderBenchView', 'function recommend(', 'function h(', 'function estimateWorkload']) assert.ok(script.includes(marker), marker);
});

test('an opaque Origin ("null") is refused with 403 on the audit endpoint too, not a 500', async () => {
  await withServer({ runner: async () => ({ report: {}, catalog: null }) }, async ({ port }) => {
    const res = await post(port, '/api/run', {}, { Origin: 'null' });
    assert.equal(res.status, 403);
  });
});
