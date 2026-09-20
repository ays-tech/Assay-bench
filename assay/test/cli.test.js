import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { main, EXIT } from '../src/cli.js';
import { createMockGateway, MOCK_KEY } from '../src/mock/gateway.js';

const sink = () => {
  let text = '';
  const stream = new Writable({ write(chunk, _e, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
};

async function cli(argv, env = {}) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { out: out.stream, err: err.stream, env: { ASSAY_SETTLE_TIMEOUT_MS: '3000', ...env } });
  return { code, out: out.text, err: err.text };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'assay-cli-'));

test('help, version and unknown commands', async () => {
  assert.equal((await cli(['--help'])).code, EXIT.OK);
  assert.match((await cli([])).out, /Usage/);
  assert.match((await cli(['--version'])).out, /^\d+\.\d+\.\d+/);
  const bad = await cli(['frobnicate']);
  assert.equal(bad.code, EXIT.USAGE);
  assert.match(bad.err, /Unknown command/);
});

test('run without a key is a clear usage error, not a crash', async () => {
  const r = await cli(['run', '--dir', tmp()]);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /ORBIO_API_KEY/);
});

test('the API key is not accepted as a flag (it would land in shell history)', async () => {
  const r = await cli(['run', '--key', 'sk-secret-value-123']);
  assert.equal(r.code, EXIT.USAGE);
  assert.ok(!r.err.includes('sk-secret-value-123') || /Unknown option/.test(r.err));
});

test('run against a clean gateway: exit 0, report saved, key never printed', async () => {
  const gw = await createMockGateway();
  const dir = tmp();
  try {
    const r = await cli(['run', '--dir', dir, '--json'], { ORBIO_API_KEY: MOCK_KEY, ORBIO_BASE_URL: gw.baseUrl });
    assert.equal(r.code, EXIT.OK, r.err);
    const report = JSON.parse(r.out);
    assert.equal(report.score.fineness, 1000);
    assert.ok(!r.out.includes(MOCK_KEY) && !r.err.includes(MOCK_KEY));
    assert.ok(existsSync(join(dir, 'latest.json')));
    assert.ok(existsSync(join(dir, 'catalog.json')), 'catalog snapshot feeds the offline estimator');
    assert.ok(!readFileSync(join(dir, 'latest.json'), 'utf8').includes(MOCK_KEY));
  } finally {
    await gw.close();
  }
});

test('--fail-under turns a bad audit into exit code 1 (CI gate)', async () => {
  const gw = await createMockGateway({ faults: ['overcharge'] });
  try {
    const r = await cli(['run', '--dir', tmp(), '--fail-under', '900'], { ORBIO_API_KEY: MOCK_KEY, ORBIO_BASE_URL: gw.baseUrl });
    assert.equal(r.code, EXIT.BELOW_THRESHOLD);
    assert.match(r.out, /FAILED/);
    assert.match(r.out, /billed above the catalog price/i);
  } finally {
    await gw.close();
  }
});

test('export writes one self-contained file and refuses when there is nothing to export', async () => {
  const empty = await cli(['export', '--dir', tmp(), '--out', join(tmp(), 'x.html')]);
  assert.equal(empty.code, EXIT.USAGE);

  const gw = await createMockGateway();
  const dir = tmp();
  try {
    await cli(['run', '--dir', dir], { ORBIO_API_KEY: MOCK_KEY, ORBIO_BASE_URL: gw.baseUrl });
    const file = join(tmp(), 'scorecard.html');
    const r = await cli(['export', '--dir', dir, '--out', file, '--public']);
    assert.equal(r.code, EXIT.OK, r.err);
    const html = readFileSync(file, 'utf8');
    assert.match(html, /<title>Assay/);
    assert.ok(!html.includes('/assets/app.js'), 'no external script references');
    assert.ok(!html.includes(MOCK_KEY));
    assert.ok(!html.includes('keyFingerprint'), '--public strips the key fingerprint');
  } finally {
    await gw.close();
  }
});

test('estimate: scans a repo against a catalog file and prices it', async () => {
  const repo = tmp();
  writeFileSync(join(repo, 'app.js'), "const c = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });\nconst m = 'anthropic/claude-haiku-4.5';\n");
  const catalog = join(tmp(), 'catalog.json');
  writeFileSync(catalog, JSON.stringify({ data: [{ id: 'anthropic/claude-haiku-4.5', name: 'Haiku', pricing: { prompt: '0.0000008', completion: '0.000004' } }] }));

  const r = await cli(['estimate', repo, '--catalog', catalog, '--input-mtok', '10', '--output-mtok', '2', '--discount', '20', '--dir', tmp()]);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.match(r.out, /openrouter\.ai\/api\/v1/);
  assert.match(r.out, /anthropic\/claude-haiku-4\.5/);
  // usage = 10×0.8 + 2×4 = $16; cash = 16 × 0.8 × 1.05 = $13.44
  assert.match(r.out, /\$16\.00/);
  assert.match(r.out, /\$13\.44/);

  const j = await cli(['estimate', repo, '--catalog', catalog, '--input-mtok', '10', '--output-mtok', '2', '--json', '--dir', tmp()]);
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.models[0].id, 'anthropic/claude-haiku-4.5');
  assert.equal(parsed.migration.length, 1);
});

test('estimate rejects nonsense inputs clearly', async () => {
  const catalog = join(tmp(), 'c.json');
  writeFileSync(catalog, JSON.stringify({ data: [] }));
  assert.equal((await cli(['estimate', '.', '--catalog', catalog, '--discount', '140'])).code, EXIT.USAGE);
  assert.equal((await cli(['estimate', '.', '--catalog', catalog, '--input-mtok', '-3'])).code, EXIT.USAGE);
  const none = await cli(['estimate', '.', '--dir', tmp()]);
  assert.equal(none.code, EXIT.USAGE);
  assert.match(none.err, /No model catalog/);
});

test('probe prints redacted raw shapes for integration debugging', async () => {
  const gw = await createMockGateway();
  try {
    const r = await cli(['probe', '--dir', tmp()], { ORBIO_API_KEY: MOCK_KEY, ORBIO_BASE_URL: gw.baseUrl });
    assert.equal(r.code, EXIT.OK, r.err);
    for (const heading of ['GET /key', 'GET /models', 'POST /chat/completions', 'Streaming']) assert.ok(r.out.includes(heading), heading);
    assert.match(r.out, /"available"/);
    assert.match(r.out, /x-orbio-balance/);
    assert.ok(!r.out.includes(MOCK_KEY));
  } finally {
    await gw.close();
  }
});

test('watch: rejects intervals that would burn credit, and runs a bounded loop', async () => {
  const gw = await createMockGateway();
  try {
    const env = { ORBIO_API_KEY: MOCK_KEY, ORBIO_BASE_URL: gw.baseUrl };
    assert.equal((await cli(['watch', '--every', '10s', '--dir', tmp()], env)).code, EXIT.USAGE);
    const r = await cli(['watch', '--every', '1m', '--max-runs', '1', '--dir', tmp()], env);
    assert.equal(r.code, EXIT.OK, r.err);
    assert.match(r.out, /fineness 1000/);
  } finally {
    await gw.close();
  }
});

test('demo runs offline with a fault and exits 0', async () => {
  const r = await cli(['demo', '--fault', 'swap', '--dir', tmp()]);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.match(r.out, /different one|different model/i);
});

/* ---------- bench ---------- */

import { createBenchResponder } from '../src/mock/bench-responder.js';
import { loadDataset } from '../src/bench/dataset.js';
import { SAMPLE_PATH } from '../src/bench/service.js';

async function withBenchGateway(fn) {
  const mock = await createMockGateway({ respond: createBenchResponder(loadDataset(SAMPLE_PATH)), latencyMs: 1, jitterMs: 1, lagMs: 20 });
  try {
    await fn({ mock, env: { ORBIO_API_KEY: MOCK_KEY, ORBIO_BASE_URL: mock.baseUrl } });
  } finally {
    await mock.close();
  }
}

const CANDS = 'anthropic/claude-haiku-4.5,google/gemini-3.8-flash,deepseek/deepseek-v4-flash';

test('bench: missing pieces are clear usage errors', async () => {
  const dir = tmp();
  const noCurrent = await cli(['bench', '--sample', '--dir', dir], { ORBIO_API_KEY: 'k' });
  assert.equal(noCurrent.code, EXIT.USAGE);
  assert.match(noCurrent.err, /--current/);
  const noData = await cli(['bench', '--current', 'a/b', '--dir', dir], { ORBIO_API_KEY: 'k' });
  assert.equal(noData.code, EXIT.USAGE);
  assert.match(noData.err, /--data <file.jsonl>, or --sample/);
  const both = await cli(['bench', '--sample', '--data', 'x.jsonl', '--current', 'a/b', '--dir', dir], { ORBIO_API_KEY: 'k' });
  assert.equal(both.code, EXIT.USAGE);
  const range = await cli(['bench', '--sample', '--current', 'a/b', '--margin', '99', '--dir', dir], { ORBIO_API_KEY: 'k' });
  assert.equal(range.code, EXIT.USAGE);
  assert.match(range.err, /--margin must be between/);
});

test('bench: a malformed dataset reports every problem with line numbers, before spending anything', async () => {
  const dir = tmp();
  const file = join(dir, 'bad.jsonl');
  writeFileSync(file, ['{"prompt":"ok","expect":{"equals":"x"}}', 'not json', '{"prompt":"no check"}'].join('\n'));
  const r = await cli(['bench', '--data', file, '--current', 'a/b', '--dir', dir], { ORBIO_API_KEY: 'k' });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /line 2: not valid JSON/);
  assert.match(r.err, /line 3: needs "expect"/);
});

test('bench --dry-run prints the plan and estimate without running the benchmark', async () => {
  await withBenchGateway(async ({ env }) => {
    const dir = tmp();
    const r = await cli(['bench', '--sample', '--current', 'openai/gpt-6-astra', '--candidates', CANDS, '--dry-run', '--rpm', '0', '--dir', dir], env);
    assert.equal(r.code, EXIT.OK, r.err);
    assert.match(r.out, /plan \(dry run/);
    assert.match(r.out, /est\. cost/);
    assert.match(r.out, /36 \(6 need a judge\)/);
    assert.equal(existsSync(join(dir, 'bench-latest.json')), false, 'nothing was saved');
  });
});

test('bench runs end to end: table, recommendation, saved report, and a machine-readable form', async () => {
  await withBenchGateway(async ({ env }) => {
    const dir = tmp();
    const r = await cli(['bench', '--sample', '--current', 'openai/gpt-6-astra', '--candidates', CANDS, '--rpm', '0', '--concurrency', '6', '--dir', dir], env);
    assert.equal(r.code, EXIT.OK, r.err);
    assert.match(r.out, /ASSAY BENCH/);
    assert.match(r.out, /cost \/ 1k correct/);
    assert.match(r.out, /gpt-6-astra/);
    assert.match(r.out, /reconciled/);
    assert.match(r.out, /assay serve/);
    assert.ok(existsSync(join(dir, 'bench-latest.json')));
    assert.ok(!r.out.includes(MOCK_KEY) && !r.err.includes(MOCK_KEY));

    const json = await cli(['bench', '--sample', '--current', 'openai/gpt-6-astra', '--candidates', CANDS, '--rpm', '0', '--concurrency', '6', '--json', '--no-samples', '--dir', dir], env);
    const report = JSON.parse(json.out);
    assert.equal(report.schema, 'assay.bench/1');
    assert.ok(report.models.every((m) => m.failures.length === 0));
    assert.equal(report.settings.marginPts, 5);
  });
});

test('bench --margin is honoured and recorded', async () => {
  await withBenchGateway(async ({ env }) => {
    const r = await cli(['bench', '--sample', '--current', 'openai/gpt-6-astra', '--candidates', CANDS, '--rpm', '0', '--concurrency', '6', '--margin', '10', '--json', '--dir', tmp()], env);
    assert.equal(JSON.parse(r.out).settings.marginPts, 10);
  });
});

test('bench: an unknown current model is a usage error with a suggestion', async () => {
  await withBenchGateway(async ({ env }) => {
    const r = await cli(['bench', '--sample', '--current', 'openai/gpt-6-astr', '--rpm', '0', '--dir', tmp()], env);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.err, /Did you mean: openai\/gpt-6-astra/);
  });
});

test('bench picks up the latest audit so the report carries a trust score', async () => {
  await withBenchGateway(async ({ env }) => {
    const dir = tmp();
    const audit = await cli(['run', '--dir', dir], env);
    assert.equal(audit.code, EXIT.OK, audit.err);
    const r = await cli(['bench', '--sample', '--current', 'openai/gpt-6-astra', '--candidates', CANDS, '--rpm', '0', '--concurrency', '6', '--json', '--dir', dir], env);
    const report = JSON.parse(r.out);
    assert.equal(report.trust.audit.fineness, 1000);
    assert.equal(report.trust.audit.grade, 'Verified');
  });
});

test('demo --bench tells the whole story offline: audit, then benchmark', async () => {
  const r = await cli(['demo', '--bench', '--dir', tmp()]);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.match(r.out, /Verified/);
  assert.match(r.out, /ASSAY BENCH/);
  assert.match(r.out, /Gateway audit: fineness 1000/);
});
