import test from 'node:test';
import assert from 'node:assert/strict';
import { median, percentile, summarize, bootstrapMedianDiff, mulberry32 } from '../src/stats.js';

test('percentile interpolates and handles edges', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('summarize reports n, p50 and p95', () => {
  const s = summarize([1, 2, 3, 4, 100]);
  assert.equal(s.n, 5);
  assert.equal(s.p50, 3);
  assert.ok(s.p95 > 4);
});

test('prng is deterministic', () => {
  const a = mulberry32(5);
  const b = mulberry32(5);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('bootstrap CI brackets a real difference and is reproducible', () => {
  const a = [110, 112, 108, 111, 113, 109, 110, 112, 111, 110];
  const b = [80, 82, 78, 81, 83, 79, 80, 82, 81, 80];
  const ci = bootstrapMedianDiff(a, b, { seed: 3 });
  assert.ok(ci.lo <= 30 && ci.hi >= 30, `CI ${ci.lo}..${ci.hi} should contain 30`);
  assert.ok(ci.lo > 20 && ci.hi < 40);
  assert.deepEqual(ci, bootstrapMedianDiff(a, b, { seed: 3 }));
});

test('bootstrap CI straddles zero for identical distributions', () => {
  const a = [50, 60, 55, 52, 58, 61, 49, 57];
  const ci = bootstrapMedianDiff(a, [...a], { seed: 9 });
  assert.ok(ci.lo < 0 && ci.hi > 0);
});
