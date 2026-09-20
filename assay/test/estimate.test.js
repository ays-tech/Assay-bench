import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blendedDiscount, cashCost, netSaving, breakEvenDiscount, estimateWorkload, BOOK_SNAPSHOT, fmtUsd, fmtPct } from '../web/pricing.js';
import { resolveModel, scanRepo } from '../src/estimate/scan.js';
import { estimateRepo } from '../src/estimate/index.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('22.5% headline discount is 18.6% net after the 5% platform fee', () => {
  close(cashCost(100, 0.225), 81.375);
  close(netSaving(0.225), 0.18625);
});

test('break-even discount is where fee cancels the discount', () => {
  close(breakEvenDiscount(0.05), 1 - 1 / 1.05);
  close(cashCost(100, breakEvenDiscount(0.05)), 100);
});

test('blended discount fills the best tiers first', () => {
  const tiers = [{ discount: 0.25, usd: 100 }, { discount: 0.1, usd: 100 }];
  close(blendedDiscount(tiers, 100).discount, 0.25);
  close(blendedDiscount(tiers, 200).discount, 0.175);
  close(blendedDiscount(tiers, 150).discount, 1 - (75 + 45) / 150);
});

test('blended discount reports what the book cannot fill', () => {
  const r = blendedDiscount([{ discount: 0.2, usd: 100 }], 250);
  assert.equal(r.shortfall, 150);
  assert.equal(r.covered, 100);
  assert.equal(blendedDiscount([], 10).covered, 0);
});

test('snapshot book: a small buyer gets more than a large one', () => {
  const small = blendedDiscount(BOOK_SNAPSHOT.tiers, 50).discount;
  const large = blendedDiscount(BOOK_SNAPSHOT.tiers, 20000).discount;
  assert.ok(small > large);
});

test('workload estimate prices tokens at catalog rate then applies the discount and fee', () => {
  const rows = [{ id: 'a/x', promptPrice: 0.000003, completionPrice: 0.000015, inputMtok: 10, outputMtok: 2 }];
  const e = estimateWorkload(rows, { discount: 0.2, fee: 0.05 });
  close(e.usage, 10 * 3 + 2 * 15); // $60
  close(e.cash, 60 * 0.8 * 1.05);
  close(e.saved, 60 - 50.4);
  close(e.annualSaved, (60 - 50.4) * 12);
  assert.equal(estimateWorkload([], {}).savedPct, 0);
});

test('workload estimate can blend the discount from the book by purchase size', () => {
  const rows = [{ id: 'a/x', promptPrice: 0.00001, completionPrice: 0, inputMtok: 1000, outputMtok: 0 }]; // $10,000
  const e = estimateWorkload(rows, { book: BOOK_SNAPSHOT.tiers });
  assert.ok(e.discount > 0.15 && e.discount < 0.25);
  assert.equal(e.shortfall, 0);
  const huge = estimateWorkload([{ ...rows[0], inputMtok: 10_000_000 }], { book: BOOK_SNAPSHOT.tiers });
  assert.ok(huge.shortfall > 0);
});

test('formatting', () => {
  assert.equal(fmtUsd(1234.5), '$1,234.50');
  assert.equal(fmtUsd(0.0042), '$0.0042');
  assert.equal(fmtPct(0.18625), '18.6%');
  assert.equal(fmtUsd(NaN), '—');
});

const catalog = [
  { id: 'anthropic/claude-sonnet-5', name: 'Sonnet 5', promptPrice: 0.000003, completionPrice: 0.000015 },
  { id: 'openai/gpt-4o', name: 'GPT-4o', promptPrice: 0.0000025, completionPrice: 0.00001 },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', promptPrice: 0.000003, completionPrice: 0.000015 },
];

test('model resolution: exact, vendor-less, dotted, dated and unknown', () => {
  assert.equal(resolveModel('anthropic/claude-sonnet-5', catalog).id, 'anthropic/claude-sonnet-5');
  assert.equal(resolveModel('gpt-4o', catalog).id, 'openai/gpt-4o');
  assert.equal(resolveModel('claude-3-5-sonnet-20241022', catalog).id, 'anthropic/claude-3.5-sonnet');
  assert.equal(resolveModel('OPENAI/GPT-4O', catalog).id, 'openai/gpt-4o');
  assert.equal(resolveModel('made-up-model', catalog), null);
  assert.equal(resolveModel('google/gpt-4o', catalog), null);
});

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'assay-scan-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'src', 'llm.ts'), [
    "const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-SUPERSECRETVALUE1234' });",
    "await client.chat.completions.create({ model: 'anthropic/claude-sonnet-5', messages });",
    "await client.chat.completions.create({ model: 'anthropic/claude-sonnet-5', messages });",
    "const cheap = 'gpt-4o';",
    "const path = 'src/utils/helpers';", // must not be mistaken for a model
    "const mystery = 'acme/frobnicator-9';",
  ].join('\n'));
  writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-ENVSECRETVALUE9999\nMODEL=anthropic/claude-sonnet-5\n');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), "const m = 'openai/gpt-4o'; fetch('https://openrouter.ai/api/v1');");
  return dir;
}

test('scanner finds endpoints, env var names and models; skips vendored code', () => {
  const scan = scanRepo(fixtureRepo(), { knownVendors: new Set(['anthropic', 'openai']) });
  assert.equal(scan.endpoints.length, 1);
  assert.equal(scan.endpoints[0].kind, 'openrouter');
  assert.equal(scan.endpoints[0].line, 1);
  assert.deepEqual(scan.envVars.map((e) => e.name), ['OPENROUTER_API_KEY']);
  assert.equal(scan.models.get('anthropic/claude-sonnet-5').count, 2, 'the .env model line must not count');
  assert.ok(scan.models.has('gpt-4o'));
  assert.ok(!scan.models.has('src/utils'), 'file paths are not models');
  assert.ok(![...scan.models.keys()].some((k) => k.includes('acme')), 'unknown vendors are ignored');
});

test('scanner never lets a secret into its output', () => {
  const scan = scanRepo(fixtureRepo(), { knownVendors: new Set(['anthropic', 'openai']) });
  const serialized = JSON.stringify({ ...scan, models: [...scan.models.entries()].map(([k, v]) => [k, v.count, [...v.files]]) });
  assert.ok(!serialized.includes('SUPERSECRET'));
  assert.ok(!serialized.includes('ENVSECRET'));
});

test('estimateRepo prices what it found and splits volume by reference count', () => {
  const r = estimateRepo({ path: fixtureRepo(), catalog, inputMtok: 30, outputMtok: 6, discount: 0.2, fee: 0.05 });
  assert.equal(r.models[0].id, 'anthropic/claude-sonnet-5');
  assert.equal(r.models[0].refs, 2);
  assert.equal(r.models.length, 2);
  assert.ok(r.estimate);
  const totalInput = r.estimate.rows.length;
  assert.equal(totalInput, 2);
  // 2/3 of volume goes to sonnet: (20 Mtok × $3) + (4 Mtok × $15) = $120; gpt-4o: (10 × 2.5) + (2 × 10) = $45
  close(r.estimate.usage, 165, 1e-6);
  assert.equal(r.unmatched.length, 0);
});

test('estimateRepo without volume still reports models and per-token facts, no invented totals', () => {
  const r = estimateRepo({ path: fixtureRepo(), catalog });
  assert.equal(r.estimate, null);
  assert.ok(r.models.length >= 1);
});
