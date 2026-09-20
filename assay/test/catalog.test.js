import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalog, selectAuditModels, detectPriceUnit } from '../src/catalog.js';
import { parseDecimal } from '../src/decimal.js';

const entry = (id, p, c, extra = {}) => ({ id, name: id, context_length: 128000, pricing: { prompt: p, completion: c }, ...extra });

test('normalizes an OpenRouter-shaped catalog per token', () => {
  const cat = normalizeCatalog({ data: [entry('a/x', '0.0000005', '0.0000015'), entry('b/y', '0.000003', '0.000015')] });
  assert.equal(cat.priceUnit, 'per_token');
  assert.equal(cat.models[0].completionPrice, parseDecimal('0.0000015'));
  assert.deepEqual(cat.issues, []);
});

test('detects and converts per-million pricing', () => {
  const cat = normalizeCatalog({ data: [entry('a/x', '0.5', '1.5'), entry('b/y', '3', '15')] });
  assert.equal(cat.priceUnit, 'per_million');
  assert.equal(cat.models[1].completionPrice, parseDecimal('0.000015'));
});

test('flags duplicates and unparseable prices; treats negatives as dynamic (unpriced)', () => {
  const cat = normalizeCatalog({ data: [entry('a/x', '1e-7', '2e-7'), entry('a/x', '1e-7', '2e-7'), entry('r/auto', '-1', '-1'), entry('c/z', 'free', '0')] });
  assert.ok(cat.issues.some((i) => i.startsWith('Duplicate')));
  assert.ok(cat.issues.some((i) => i.includes('Unparseable')));
  assert.equal(cat.models.find((m) => m.id === 'r/auto').promptPrice, null);
  assert.ok(cat.unpriced >= 2);
});

test('reports a structural problem instead of throwing', () => {
  assert.equal(normalizeCatalog({ oops: true }).models.length, 0);
  assert.equal(normalizeCatalog(null).issues.length, 1);
  assert.equal(detectPriceUnit([]), 'per_token');
});

test('selects the cheapest viable model per vendor, skipping reasoning/free/embedding variants', () => {
  const cat = normalizeCatalog({
    data: [
      entry('anthropic/claude-big', '0.00001', '0.00005'),
      entry('anthropic/claude-small', '0.0000008', '0.000004'),
      entry('openai/gpt-x', '0.000002', '0.00001'),
      entry('openai/o3-mini', '0.0000001', '0.0000004'),
      entry('google/gemini-free:free', '0', '0'),
      entry('google/gemini-flash', '0.0000003', '0.0000025'),
      entry('acme/embed-v1', '0.00000001', '0.00000001'),
    ],
  });
  const { selected } = selectAuditModels(cat.models, { count: 3 });
  assert.deepEqual(selected.map((m) => m.id), ['anthropic/claude-small', 'openai/gpt-x', 'google/gemini-flash']);
});

test('honours explicit models and reports missing ones', () => {
  const cat = normalizeCatalog({ data: [entry('a/x', '1e-7', '2e-7')] });
  const { selected, missing } = selectAuditModels(cat.models, { explicit: ['a/x', 'nope/none'] });
  assert.equal(selected.length, 1);
  assert.deepEqual(missing, ['nope/none']);
});

test('variant endpoints (:batch, :free, :extended) are never auto-selected; the plain model is', () => {
  // Found live: "openai/gpt-5-nano:batch" was picked and could not answer chat calls.
  const cat = normalizeCatalog({ data: [
    entry('openai/gpt-5-nano:batch', '0.00000001', '0.00000002'),
    entry('openai/gpt-5-nano', '0.00000005', '0.0000004'),
    entry('google/gemma-3-4b-it', '0.00000002', '0.00000004'),
  ] });
  const { selected } = selectAuditModels(cat.models, { count: 3 });
  assert.ok(!selected.some((m) => m.id.includes(':')));
  assert.ok(selected.some((m) => m.id === 'openai/gpt-5-nano'));
});

test('selection returns ranked alternates so a failed model can be replaced', () => {
  const cat = normalizeCatalog({ data: [
    entry('anthropic/a1', '0.000001', '0.000004'), entry('anthropic/a2', '0.000002', '0.000008'),
    entry('openai/o1x', '0.000001', '0.000004'), entry('google/g1', '0.000001', '0.000004'), entry('deepseek/d1', '0.000001', '0.000004'),
  ] });
  const { selected, alternates } = selectAuditModels(cat.models, { count: 2 });
  assert.equal(selected.length, 2);
  assert.ok(alternates.length >= 3);
  assert.equal(new Set([...selected, ...alternates].map((m) => m.id)).size, selected.length + alternates.length, 'no duplicates');
});
