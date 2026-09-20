import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, validateSchema } from '../src/bench/schema.js';
import { runChecks, deepMatch } from '../src/bench/checks.js';
import { parseDataset, DatasetError } from '../src/bench/dataset.js';
import { parseVerdict, combineVerdicts, judgeCandidates, judgeMessages, JUDGE_MARKER } from '../src/bench/judge.js';
import { recommend, describe, samplesNeeded } from '../src/bench/recommend.js';
import { mapLimit, createRateLimiter } from '../src/bench/pool.js';
import { wilson, bootstrapPaired } from '../src/stats.js';
import { normalizeCatalog } from '../src/catalog.js';

/* ---------- JSON extraction & schema ---------- */

test('extractJson finds JSON in prose, fences, and nested strings with braces', () => {
  assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go:\n```json\n{"a": 2}\n```\nHope it helps').value, { a: 2 });
  assert.deepEqual(extractJson('The answer is {"a": "has } brace"} okay').value, { a: 'has } brace' });
  assert.deepEqual(extractJson('Result: [1, 2, 3]').value, [1, 2, 3]);
  assert.equal(extractJson('no json here').ok, false);
  assert.equal(extractJson('{"broken": ').ok, false);
  assert.equal(extractJson('').ok, false);
  assert.equal(extractJson(null).ok, false);
});

test('validateSchema: types, enums, required, nesting, additionalProperties', () => {
  const schema = { type: 'object', required: ['category', 'priority'], additionalProperties: false, properties: {
    category: { type: 'string', enum: ['billing', 'bug'] }, priority: { type: 'integer', minimum: 1, maximum: 4 }, tags: { type: 'array', items: { type: 'string' }, maxItems: 2 } } };
  assert.deepEqual(validateSchema({ category: 'bug', priority: 2, tags: ['a'] }, schema), []);
  assert.match(validateSchema({ category: 'refund', priority: 2 }, schema)[0], /not one of/);
  assert.match(validateSchema({ category: 'bug' }, schema)[0], /missing required "priority"/);
  assert.match(validateSchema({ category: 'bug', priority: 9 }, schema)[0], /above the maximum/);
  assert.match(validateSchema({ category: 'bug', priority: 1, extra: 1 }, schema)[0], /unexpected property/);
  assert.match(validateSchema({ category: 'bug', priority: 1, tags: ['a', 'b', 'c'] }, schema)[0], /more than 2 items/);
  assert.match(validateSchema({ category: 'bug', priority: 1.5 }, schema)[0], /expected integer/);
  assert.match(validateSchema('x', schema)[0], /expected object/);
});

/* ---------- deterministic checks ---------- */

test('runChecks: fields compare case-insensitively and tolerate wrapping prose', () => {
  const expect = { fields: { category: 'billing', priority: 'high' } };
  assert.equal(runChecks(expect, '{"category":"Billing","priority":" HIGH "}').pass, true);
  assert.equal(runChecks(expect, 'Here: ```json\n{"category":"billing","priority":"high","note":"x"}\n```').pass, true, 'extra fields are fine');
  const wrong = runChecks(expect, '{"category":"bug","priority":"high"}');
  assert.equal(wrong.pass, false);
  assert.match(wrong.results.find((r) => r.name === 'fields').detail, /expected/);
  assert.equal(runChecks(expect, 'I cannot answer that').pass, false);
});

test('runChecks: equals, contains, notContains, regex, maxChars, and failed calls', () => {
  assert.equal(runChecks({ equals: 'Paris' }, ' paris \n').pass, true);
  assert.equal(runChecks({ contains: ['refund', '3 days'] }, 'We will refund you within 3 Days.').pass, true);
  assert.equal(runChecks({ contains: ['refund'] }, 'nothing').pass, false);
  assert.equal(runChecks({ notContains: ['sorry'] }, 'We are Sorry').pass, false);
  assert.equal(runChecks({ regex: '^\\d{4}$' }, '2026').pass, true);
  assert.equal(runChecks({ maxChars: 5 }, 'too long').pass, false);
  const failedCall = runChecks({ equals: 'x' }, null);
  assert.equal(failedCall.pass, false, 'no answer is a wrong answer');
  assert.equal(runChecks(undefined, 'x').hasChecks, false);
});

test('deepMatch is a subset match, strict on arrays', () => {
  assert.equal(deepMatch({ a: 1, b: { c: 'X' } }, { b: { c: 'x' } }), true);
  assert.equal(deepMatch({ a: [1, 2] }, { a: [1, 2, 3] }), false);
  assert.equal(deepMatch({ a: 1 }, { a: 2 }), false);
});

/* ---------- dataset ---------- */

test('parseDataset accepts prompt/system, messages, checks and judges', () => {
  const items = parseDataset([
    '{"id":"a","system":"Be terse.","prompt":"2+2?","expect":{"equals":"4"}}',
    '',
    '{"messages":[{"role":"user","content":"Reply politely"}],"judge":"Polite and short"}',
    '{"prompt":"x","expect":{"regex":"^x"},"judge":true,"max_tokens":50}',
  ].join('\n'));
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].messages.map((m) => m.role), ['system', 'user']);
  assert.equal(items[1].id, 'p2');
  assert.equal(items[1].judge.rubric, 'Polite and short');
  assert.equal(items[2].maxTokens, 50);
});

test('parseDataset reports every problem at once, with line numbers', () => {
  try {
    parseDataset(['{"prompt":"ok","expect":{"equals":"x"}}', 'not json', '{"prompt":"no checks"}', '{"expect":{"equals":"x"}}', '{"prompt":"p","expect":{"bogus":1}}', '{"id":"d","prompt":"p","expect":{"regex":"("}}'].join('\n'));
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof DatasetError);
    assert.match(e.message, /line 2: not valid JSON/);
    assert.match(e.message, /line 3: needs "expect"/);
    assert.match(e.message, /line 4: needs "prompt"/);
    assert.match(e.message, /line 5: unknown check "bogus"/);
    assert.match(e.message, /line 6: "regex" is not a valid pattern/);
  }
  assert.throws(() => parseDataset(''), /empty/);
  assert.throws(() => parseDataset('{"id":"a","prompt":"x","expect":{"equals":"1"}}\n{"id":"a","prompt":"y","expect":{"equals":"2"}}'), /duplicate id/);
});

/* ---------- judge ---------- */

test('parseVerdict is tolerant of formatting but never guesses', () => {
  assert.equal(parseVerdict('{"winner":"A"}'), 'A');
  assert.equal(parseVerdict('Sure. {"winner": "b"} because…'), 'B');
  assert.equal(parseVerdict('{"winner":"Tie"}'), 'tie');
  assert.equal(parseVerdict('winner: A'), 'A');
  assert.equal(parseVerdict('Both are fine'), null);
  assert.equal(parseVerdict('{"winner":"C"}'), null);
  assert.equal(parseVerdict(null), null);
});

test('combineVerdicts cancels position bias: a judge that always says "A" yields a tie, flagged', () => {
  // reference first: A = current, B = candidate. candidate first: A = candidate, B = current.
  const alwaysA = combineVerdicts('A', 'A'); // current wins one, candidate wins the other
  assert.equal(alwaysA.score, 0.5);
  assert.equal(alwaysA.positionBiased, true);
  const alwaysB = combineVerdicts('B', 'B');
  assert.equal(alwaysB.score, 0.5);
  assert.equal(alwaysB.positionBiased, true);

  const candidateWins = combineVerdicts('B', 'A');
  assert.equal(candidateWins.score, 1);
  assert.equal(candidateWins.positionBiased, false);
  assert.equal(combineVerdicts('A', 'B').score, 0);
  assert.equal(combineVerdicts('tie', 'tie').score, 0.5);
  assert.equal(combineVerdicts('B', null).score, 1);
  assert.equal(combineVerdicts('B', null).valid, 1);
  assert.equal(combineVerdicts(null, null).score, null);
});

test('judge selection never picks the current or candidate vendor and prefers the middle of a vendor range', () => {
  const entry = (id, c) => ({ id, name: id, context_length: 128000, pricing: { prompt: String(c / 4), completion: String(c) } });
  const cat = normalizeCatalog({ data: [
    entry('anthropic/cheap', 1e-7), entry('anthropic/mid', 1e-6), entry('anthropic/big', 1e-5),
    entry('openai/o-cheap', 1e-7), entry('openai/o-mid', 2e-6), entry('openai/o-big', 2e-5),
    entry('google/g1', 1e-6), entry('anthropic/haiku:beta', 1e-6),
  ] });
  const picks = judgeCandidates(cat.models, { avoid: new Set(['anthropic']) });
  assert.ok(picks.every((m) => m.vendor !== 'anthropic'));
  assert.equal(picks.find((m) => m.vendor === 'openai').id, 'openai/o-mid');
  assert.ok(!picks.some((m) => m.id.includes(':')));
  const msgs = judgeMessages({ task: 'T', rubric: 'R', a: 'AA', b: 'BB' });
  assert.match(msgs[0].content, new RegExp(JUDGE_MARKER));
  assert.match(msgs[1].content, /Answer A:\nAA[\s\S]*Answer B:\nBB/);
});

/* ---------- statistics ---------- */

test('wilson interval is honest at the extremes and small n', () => {
  const half = wilson(50, 100);
  assert.ok(half.lo > 0.40 && half.hi < 0.60);
  const perfectSmall = wilson(10, 10);
  assert.ok(perfectSmall.hi <= 1 && perfectSmall.lo < 0.8, 'ten out of ten must NOT look like certainty');
  assert.ok(wilson(0, 10).lo === 0 && wilson(0, 10).hi > 0.2);
  assert.ok(Number.isNaN(wilson(0, 0).p));
});

test('paired bootstrap: equal models straddle zero; a clearly worse model is clearly negative; deterministic', () => {
  const current = Array.from({ length: 60 }, (_, i) => (i % 10 === 0 ? 0 : 1)); // 90 %
  const same = bootstrapPaired(current, [...current], { seed: 5 });
  assert.equal(same.diff.est, 0);
  assert.equal(same.ratio.est, 1);
  assert.equal(same.diffSd, 0);

  const worse = current.map((c, i) => (i % 2 === 0 ? 0 : c)); // loses half its answers
  const r = bootstrapPaired(current, worse, { seed: 5 });
  assert.ok(r.diff.hi < -0.2, `hi=${r.diff.hi}`);
  assert.ok(r.ratio.est < 0.6);
  assert.deepEqual(r, bootstrapPaired(current, worse, { seed: 5 }));

  const noisy = current.map((c, i) => (i % 20 === 3 ? 1 - c : c));
  const n = bootstrapPaired(current, noisy, { seed: 2 });
  assert.ok(n.diff.lo <= n.diff.est && n.diff.est <= n.diff.hi);
});

/* ---------- the decision rule ---------- */

const m = (id, o = {}) => ({ id, isCurrent: false, costPer1k: 1, n: 60, accuracy: 0.9, diff: { est: 0, lo: -0.03, hi: 0.03 }, diffSd: 0.2, costPerCorrect: 1.1, errorRate: 0, ...o });
const current = { id: 'big/model', isCurrent: true, costPer1k: 10, n: 60, accuracy: 0.9, diff: null, diffSd: null, costPerCorrect: 11.1, errorRate: 0 };

test('recommend: switches only when the pessimistic bound clears the margin, and picks lowest cost per correct answer', () => {
  const rec = recommend([current, m('a/cheap', { costPer1k: 1, costPerCorrect: 1.1 }), m('b/cheaper', { costPer1k: 0.5, costPerCorrect: 0.7, diff: { est: -0.02, lo: -0.04, hi: 0.01 } })]);
  assert.equal(rec.action, 'switch');
  assert.equal(rec.model, 'b/cheaper');
  assert.ok(Math.abs(rec.savings - 0.95) < 1e-9);
  assert.match(describe(rec, [current, m('b/cheaper', { accuracy: 0.88 })]).headline, /Switch to cheaper: 95% cheaper/);
});

test('recommend: a promising point estimate with a wide interval is NOT a switch', () => {
  const wide = m('a/cheap', { n: 30, diff: { est: -0.01, lo: -0.15, hi: 0.12 }, diffSd: 0.35 });
  const rec = recommend([current, wide]);
  assert.equal(rec.action, 'need-more-data');
  assert.equal(rec.perModel['a/cheap'].verdict, 'inconclusive');
  assert.ok(rec.neededSamples > 30, `needs more than the current 30, got ${rec.neededSamples}`);
  assert.match(describe(rec, [current, wide]).headline, /cannot prove it/);
});

test('recommend: too few prompts is insufficient no matter how good it looks', () => {
  const rec = recommend([current, m('a/cheap', { n: 8, diff: { est: 0, lo: 0, hi: 0 } })]);
  assert.equal(rec.perModel['a/cheap'].verdict, 'insufficient');
  assert.notEqual(rec.action, 'switch');
});

test('recommend: clearly worse and unreliable models are never recommended; keep is a valid answer', () => {
  const worse = m('a/dumb', { diff: { est: -0.3, lo: -0.4, hi: -0.2 } });
  const flaky = m('b/flaky', { errorRate: 0.5 });
  const rec = recommend([current, worse, flaky]);
  assert.equal(rec.action, 'keep');
  assert.equal(rec.perModel['a/dumb'].verdict, 'worse');
  assert.equal(rec.perModel['b/flaky'].verdict, 'unreliable');
  assert.match(describe(rec, [current, worse, flaky]).headline, /^Keep model\./);
});

test('recommend: savings below the threshold do not justify a switch', () => {
  const rec = recommend([current, m('a/almost-same-price', { costPer1k: 9.5 })]);
  assert.equal(rec.action, 'keep');
});

test('samplesNeeded shrinks as the observed effect improves and is null when already worse than the margin', () => {
  const tight = samplesNeeded({ est: 0 }, 0.3, 0.05);
  const better = samplesNeeded({ est: 0.05 }, 0.3, 0.05);
  assert.ok(better < tight);
  assert.equal(samplesNeeded({ est: -0.06 }, 0.3, 0.05), null);
  assert.equal(samplesNeeded({ est: 0 }, null, 0.05), null);
  assert.equal(samplesNeeded({ est: -0.049 }, 0.5, 0.05), null, 'unrealistically large requirement is reported as null, not a fantasy number');
});

/* ---------- pool ---------- */

test('mapLimit preserves order and never exceeds the concurrency limit', async () => {
  let active = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (x) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5 * (9 - x))); active--; return x * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3 && peak >= 2);
});

test('rate limiter spaces starts by 60000/rpm across all callers', async () => {
  // Fake clock frozen at 0; record the delay each caller is told to wait.
  let last = 0;
  const wait = createRateLimiter(60, { now: () => 0, sleep: async (ms) => { last = ms; } });
  const delays = [];
  for (let i = 0; i < 4; i++) {
    last = 0;
    const pending = wait(); // the scheduling decision is made synchronously
    delays.push(last);
    await pending;
  }
  assert.deepEqual(delays, [0, 1000, 2000, 3000], 'four callers arriving together start one second apart');
  const unlimited = createRateLimiter(0, { now: () => 0, sleep: async () => { throw new Error('must not sleep'); } });
  await unlimited();
});
