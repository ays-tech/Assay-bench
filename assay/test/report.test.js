import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, gradeFor } from '../src/score.js';
import { buildHeadline } from '../src/summary.js';
import { validateNarrative, narrationFacts } from '../src/narrate.js';
import { redact, keyFingerprint } from '../src/redact.js';

const r = (id, status, weight = 10) => ({ id, status, weight });

test('score: all pass is 1000 with high confidence', () => {
  const s = computeScore([r('billing', 'pass', 30), r('identity', 'pass', 20), r('compat', 'pass', 15)]);
  assert.equal(s.fineness, 1000);
  assert.equal(s.grade, 'Verified');
});

test('score: warn counts half; skip and info are excluded from the score', () => {
  const s = computeScore([r('billing', 'pass', 50), r('compat', 'warn', 50), r('latency', 'info', 10), r('tokens', 'skip', 10)]);
  assert.equal(s.fineness, 750);
  assert.equal(s.coverage, 0.83);
});

test('score: an integrity failure caps fineness so it cannot be averaged away', () => {
  const s = computeScore([r('billing', 'fail', 30), r('identity', 'pass', 20), r('tokens', 'pass', 15), r('compat', 'pass', 15), r('catalog', 'pass', 5), r('auth', 'pass', 5)]);
  assert.equal(s.fineness, 600);
  assert.equal(s.capped, true);
  const nonIntegrity = computeScore([r('compat', 'fail', 15), r('billing', 'pass', 30), r('identity', 'pass', 20), r('tokens', 'pass', 15)]);
  assert.equal(nonIntegrity.capped, false);
});

test('score: low coverage withholds the top grade; no evidence has no score', () => {
  const s = computeScore([r('auth', 'pass', 5), r('billing', 'skip', 30), r('identity', 'skip', 20), r('tokens', 'skip', 15), r('compat', 'skip', 15)]);
  assert.equal(s.fineness, 1000);
  assert.equal(s.grade, 'Partially verified');
  assert.equal(computeScore([r('billing', 'skip', 30)]).fineness, null);
  assert.equal(gradeFor(499), 'Failed');
  assert.equal(gradeFor(700), 'Concerns');
  assert.equal(gradeFor(900), 'Mostly verified');
});

test('headline: says what failed, what to review, or what held up', () => {
  assert.match(buildHeadline([r('billing', 'fail'), r('identity', 'pass')]), /billed above the catalog price/);
  assert.match(buildHeadline([r('compat', 'warn'), r('billing', 'pass')]), /^No failures\./);
  assert.equal(buildHeadline([r('billing', 'pass'), r('identity', 'pass')]), 'Billing and model identity held up.');
  assert.match(buildHeadline([r('billing', 'skip'), r('identity', 'pass')]), /Billing could not be verified/);
});

test('narrative guard: rejects numbers that are not in the evidence', () => {
  const facts = narrationFacts({ score: { fineness: 972, grade: 'Verified', coverage: 0.9 }, spend: { calls: 27 }, checks: [{ id: 'billing', status: 'pass', summary: 'Billed 1.003× catalog over 12 calls' }] });
  assert.equal(validateNarrative('Fineness is 972 and billing ran 12 calls at 1.003× catalog.', facts).ok, true);
  const invented = validateNarrative('Fineness is 972 and Orbio saved 41 percent.', facts);
  assert.equal(invented.ok, false);
  assert.match(invented.reason, /41/);
  assert.equal(validateNarrative('Too short.', facts).ok, false);
});

test('redact strips keys, bearer tokens and explicit secrets', () => {
  const secret = 'my-plain-secret-value';
  const text = `Authorization: Bearer abcdef1234567890 sk-orbio-abc123DEF456 ${secret}`;
  const out = redact(text, [secret]);
  assert.ok(!out.includes('abcdef1234567890'));
  assert.ok(!out.includes('sk-orbio-abc123DEF456'));
  assert.ok(!out.includes(secret));
  assert.equal(keyFingerprint('k').length, 8);
});
