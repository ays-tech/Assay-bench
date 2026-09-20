import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockGateway, MOCK_KEY } from '../src/mock/gateway.js';
import { createBenchResponder } from '../src/mock/bench-responder.js';
import { loadDataset, parseDataset } from '../src/bench/dataset.js';
import { SAMPLE_PATH } from '../src/bench/service.js';
import { resolveConfig } from '../src/config.js';
import { OrbioClient } from '../src/client.js';
import { runBench, BenchError, autoCandidates, sampleItems } from '../src/bench/run.js';
import { recommend, statsFromReport } from '../src/bench/recommend.js';
import { normalizeCatalog } from '../src/catalog.js';

const dataset = loadDataset(SAMPLE_PATH);
const CANDIDATES = ['anthropic/claude-haiku-4.5', 'google/gemini-3.8-flash', 'openai/gpt-6-mini', 'deepseek/deepseek-v4-flash'];

/** Run a benchmark against a fresh mock gateway. */
async function bench({ mock = {}, items = dataset, respond, cap = '5', ...options } = {}) {
  const gateway = await createMockGateway({ respond: respond ?? createBenchResponder(items), latencyMs: 1, jitterMs: 1, lagMs: 20, ...mock });
  try {
    const config = { ...resolveConfig({ key: MOCK_KEY, 'base-url': gateway.baseUrl, 'max-spend': cap }, {}), settleTimeoutMs: 3000, settlePollMs: 30 };
    const client = new OrbioClient({ baseUrl: gateway.baseUrl, apiKey: MOCK_KEY });
    return await runBench({ config, client, dataset: items, datasetName: 'test', current: 'openai/gpt-6-astra', candidates: CANDIDATES, rpm: 0, concurrency: 6, ...options });
  } finally {
    await gateway.close();
  }
}

test('a full benchmark: paired scoring, honest billing, judges from other vendors', async () => {
  const { report } = await bench();
  assert.equal(report.schema, 'assay.bench/1');
  assert.equal(report.models[0].role, 'current');
  assert.equal(report.models.length, 5);

  // every model scored on the same prompts
  assert.ok(report.models.every((m) => m.n === dataset.length));
  assert.equal(report.dataset.prompts, dataset.length);

  // the run itself is a billing audit: hundreds of calls, reconciled against the balance
  assert.equal(report.trust.billing.verdict, 'ok');
  assert.ok(report.trust.billing.calls >= 200, `calls=${report.trust.billing.calls}`);
  assert.ok(report.trust.billing.ratio > 0.99 && report.trust.billing.ratio < 1.02, `ratio=${report.trust.billing.ratio}`);
  assert.equal(report.trust.audit, null, 'no audit was supplied');
  assert.equal(report.spend.partial, false);
  assert.deepEqual(report.notes, []);

  // skill ordering shows through, and the tiny model is measurably worse
  const acc = Object.fromEntries(report.models.map((m) => [m.id, m.accuracy]));
  assert.ok(acc['openai/gpt-6-mini'] > acc['deepseek/deepseek-v4-flash']);
  assert.equal(report.models.find((m) => m.id === 'deepseek/deepseek-v4-flash').verdict, 'worse');

  // cheaper models really are cheaper, and cost per correct answer accounts for their misses
  const cost = Object.fromEntries(report.models.map((m) => [m.id, m.costPer1kUsd]));
  assert.ok(cost['deepseek/deepseek-v4-flash'] < cost['openai/gpt-6-mini'] && cost['openai/gpt-6-mini'] < cost['openai/gpt-6-astra']);
  for (const m of report.models) assert.ok(Math.abs(m.costPerCorrect1kUsd - m.costPer1kUsd / m.accuracy) < 1e-9);

  // a judge never shares a vendor with the current model or the candidate it grades
  for (const m of report.models.filter((x) => x.role === 'candidate')) {
    assert.ok(m.judge, `${m.id} has judge stats`);
    const vendor = m.judge.model.split('/')[0];
    assert.notEqual(vendor, 'openai', 'never the current model\'s vendor');
    assert.notEqual(vendor, m.id.split('/')[0], 'never the candidate\'s own vendor');
    assert.equal(m.judge.pairs, 6);
  }
  assert.ok(!JSON.stringify(report).includes(MOCK_KEY), 'the API key never reaches a report');
});

test('the recommendation can only loosen as the margin widens, and never rests on a point estimate', async () => {
  const { report } = await bench();
  const stats = statsFromReport(report.models);
  const rank = { keep: 0, 'need-more-data': 1, switch: 2 };
  let previous = -1;
  for (const marginPts of [1, 2, 5, 10, 15, 30]) {
    const rec = recommend(stats, { marginPts });
    assert.ok(rank[rec.action] >= previous, `margin ${marginPts}: ${rec.action} regressed`);
    previous = rank[rec.action];
    if (rec.action === 'switch') {
      const chosen = stats.find((m) => m.id === rec.model);
      assert.ok(chosen.diff.lo >= -marginPts / 100, 'a switch requires the pessimistic bound to clear the margin');
    }
  }
  // with only 36 prompts, a 5-point margin should not be provable for a model that is not clearly better
  assert.notEqual(recommend(stats, { marginPts: 5 }).action, 'switch');
});

test('a dry run plans and estimates without benchmarking', async () => {
  const result = await bench({ dryRun: true });
  assert.equal(result.report, undefined);
  assert.equal(result.plan.current, 'openai/gpt-6-astra');
  assert.deepEqual(result.plan.candidates, CANDIDATES);
  assert.equal(result.plan.prompts, dataset.length);
  assert.equal(result.plan.judgedPrompts, 6);
  assert.ok(result.plan.estimate.usd > 0 && result.plan.estimate.calls > 100);
  assert.equal(Object.keys(result.plan.judges).length, CANDIDATES.length);
});

test('a candidate that cannot answer is skipped and reported, not silently benchmarked', async () => {
  const { report } = await bench({ mock: { brokenModels: ['deepseek/deepseek-v4-flash'] } });
  assert.deepEqual(report.skipped.map((s) => s.id), ['deepseek/deepseek-v4-flash']);
  assert.match(report.skipped[0].error, /502/);
  assert.ok(!report.models.some((m) => m.id === 'deepseek/deepseek-v4-flash'));
  assert.equal(report.models.length, 4);
});

test('a broken current model stops the run; a misspelt one gets suggestions', async () => {
  await assert.rejects(bench({ mock: { brokenModels: ['openai/gpt-6-astra'] } }), /current model openai\/gpt-6-astra did not answer/);
  await assert.rejects(bench({ current: 'openai/gpt-6-astr' }), (e) => e instanceof BenchError && /Did you mean: openai\/gpt-6-astra/.test(e.message));
  await assert.rejects(bench({ candidates: ['nope/nothing'] }), /None of the candidate models could be used/);
});

test('refuses up front when the estimate exceeds the cap, instead of wasting money on a partial result', async () => {
  await assert.rejects(bench({ cap: '0.01' }), /exceeds the spend cap/);
});

test('when the spend cap is hit mid-run, only prompts every model finished are scored, and it says so', async () => {
  const items = parseDataset(Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: `q${i}`, prompt: `Question number ${i}`, expect: { maxChars: 9000 } })).join('\n'));
  const talkative = ({ messages }) => (messages.some((m) => /single word: ok/.test(m.content)) ? null : 'blah '.repeat(240)); // ~1,200 characters every time
  const plan = (await bench({ items, respond: talkative, dryRun: true, maxTokens: 400 })).plan;
  const { report } = await bench({ items, respond: talkative, maxTokens: 400, cap: String((plan.estimate.usd * 1.25).toFixed(6)) });
  assert.equal(report.spend.partial, true);
  assert.ok(report.dataset.prompts > 0 && report.dataset.prompts < 30, `scored ${report.dataset.prompts}`);
  assert.ok(report.models.every((m) => m.n === report.dataset.prompts), 'every model compared on the same prompts');
  assert.match(report.notes.join(' '), /spend cap stopped the run early/);
  assert.ok(Number(report.spend.actualUsd) <= Number(report.spend.capUsd) * 1.05, 'the cap held');
});

test('deterministic: the same inputs give the same statistics', async () => {
  const [a, b] = [await bench({ limit: 30 }), await bench({ limit: 30 })];
  const strip = (r) => r.report.models.map((m) => [m.id, m.correct, m.diff, m.qualityVsCurrent]);
  assert.deepEqual(strip(a), strip(b));
});

test('a dataset with only hard checks needs no judge at all', async () => {
  const items = parseDataset(Array.from({ length: 24 }, (_, i) => JSON.stringify({ id: `t${i}`, prompt: `Say ${i}`, expect: { contains: [String(i)] } })).join('\n'));
  const respond = ({ model, messages }) => (messages.some((m) => /single word: ok/.test(m.content)) ? null : model.includes('deepseek') ? 'no idea' : messages.at(-1).content.replace('Say ', 'It is '));
  const { report } = await bench({ items, respond });
  assert.ok(report.models.every((m) => m.judge === null));
  assert.equal(report.models.find((m) => m.id === 'anthropic/claude-haiku-4.5').accuracy, 1);
  assert.equal(report.models.find((m) => m.id === 'deepseek/deepseek-v4-flash').accuracy, 0);
  assert.equal(report.spend.judgeUsd, '0.000000000');
});

test('--no-samples keeps answer excerpts out of the report', async () => {
  const withSamples = (await bench({ samples: true })).report;
  const without = (await bench({ samples: false })).report;
  assert.ok(withSamples.models.some((m) => m.failures.length > 0));
  assert.ok(without.models.every((m) => m.failures.length === 0));
});

/* ---------- candidate selection ---------- */

const entry = (id, prompt, completion) => ({ id, name: id, context_length: 128000, pricing: { prompt: String(prompt), completion: String(completion) } });

test('autoCandidates: cheaper only, several vendors, the priciest that still fits, plus the floor; never the current model or a variant', () => {
  const cat = normalizeCatalog({ data: [
    entry('big/flagship', 1e-5, 4e-5),
    entry('anthropic/mid', 1e-6, 4e-6), entry('anthropic/tiny', 1e-7, 4e-7), entry('anthropic/mid:batch', 5e-7, 2e-6),
    entry('google/mid', 2e-6, 6e-6), entry('google/pricey', 9e-6, 3e-5),
    entry('deepseek/tiny', 2e-8, 8e-8),
  ] });
  const current = cat.models.find((m) => m.id === 'big/flagship');
  const picks = autoCandidates(cat.models, current, { count: 4 }).map((m) => m.id);
  assert.ok(picks.includes('anthropic/mid') && picks.includes('google/mid'), picks.join());
  assert.ok(picks.includes('deepseek/tiny'), 'the absolute cheapest is included as a floor');
  assert.ok(!picks.includes('google/pricey') && !picks.includes('big/flagship') && !picks.some((id) => id.includes(':')));
  assert.ok(!picks.includes('anthropic/tiny'), 'one per vendor, the strongest that fits');
});

test('sampleItems is deterministic, keeps dataset order, and returns everything when the limit is generous', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}` }));
  const a = sampleItems(items, 12);
  assert.deepEqual(a, sampleItems(items, 12));
  assert.equal(a.length, 12);
  assert.deepEqual(a.map((x) => Number(x.id.slice(1))), [...a.map((x) => Number(x.id.slice(1)))].sort((x, y) => x - y));
  assert.equal(sampleItems(items, 500), items);
  assert.equal(sampleItems(items, undefined), items);
});
