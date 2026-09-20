import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBatch, judgeBatches } from '../src/checks/billing.js';
import { evaluateTokens } from '../src/checks/tokens.js';
import { declaredMatch, normalizeModelName, evaluateIdentity } from '../src/checks/identity.js';
import { evaluateStream, evaluateToolCall, evaluateErrorEnvelope } from '../src/checks/compat.js';
import { evaluateOverhead } from '../src/checks/latency.js';
import { parseKeyResponse } from '../src/checks/balance.js';
import { parseDecimal } from '../src/decimal.js';
import { CANARY_CHARS } from '../src/probe.js';

const D = parseDecimal;
const bal = (available, used = '0') => ({ available: D(available), used: D(used), availableRaw: available, usedRaw: used });
const call = (over = {}) => ({
  tag: 'billing', model: 'a/x', respModel: 'x', ok: true, source: 'gateway', promptTokens: 500, completionTokens: 2, totalTokens: 502,
  maxTokens: 16, expectedCost: D('0.001'), reportedCost: null, balanceHeader: null, balanceHeaderRaw: null, ...over,
});

/* ---------- billing ---------- */

test('billing: exact match is ok and funds are conserved', () => {
  const calls = Array.from({ length: 5 }, () => call());
  const ev = evaluateBatch({ calls, before: bal('5.000000'), after: { ...bal('4.995000', '0.005000'), settled: true, waitedMs: 300 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.equal(ev.verdict, 'ok');
  assert.equal(ev.ratio, 1);
  assert.equal(ev.conservation.ok, true);
  assert.equal(judgeBatches([ev]).status, 'pass');
});

test('billing: 50% overcharge is "over"; one batch only warns and asks to confirm', () => {
  const calls = Array.from({ length: 5 }, () => call());
  const over = evaluateBatch({ calls, before: bal('5.000000'), after: { ...bal('4.992500', '0.007500'), settled: true, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.equal(over.verdict, 'over');
  const single = judgeBatches([over]);
  assert.equal(single.status, 'warn');
  assert.equal(single.escalate, true);
  assert.equal(judgeBatches([over, over]).status, 'fail');
});

test('billing: an anomaly that does not reproduce stays a warning', () => {
  const calls = Array.from({ length: 5 }, () => call());
  const mk = (after) => evaluateBatch({ calls, before: bal('5.000000'), after: { ...after, settled: true, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  const over = mk(bal('4.992500', '0.007500'));
  const fine = mk(bal('4.995000', '0.005000'));
  const verdict = judgeBatches([over, fine]);
  assert.equal(verdict.status, 'warn');
  assert.equal(verdict.escalate, false);
});

test('billing: rounding of one balance unit per call never causes a false alarm', () => {
  // 10 calls costing $0.0000105 each; the gateway rounds every charge UP to the next micro-dollar ($0.000011).
  const calls = Array.from({ length: 10 }, () => call({ expectedCost: D('0.0000105') }));
  const ev = evaluateBatch({ calls, before: bal('5.000000'), after: { ...bal('4.999890', '0.000110'), settled: true, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.equal(ev.verdict, 'ok');
  // The same movement on a coarser expectation of $0.0000090/call (billed 22% over) must still be caught.
  const cheap = Array.from({ length: 10 }, () => call({ expectedCost: D('0.0000090') }));
  const over = evaluateBatch({ calls: cheap, before: bal('5.000000'), after: { ...bal('4.999890', '0.000110'), settled: true, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.notEqual(over.verdict, 'ok');
});

test('billing: coarse balance precision is unresolvable, not a pass', () => {
  const calls = [call({ expectedCost: D('0.0004') })];
  const ev = evaluateBatch({ calls, before: bal('5.00'), after: { ...bal('5.00'), settled: false, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.equal(ev.verdict, 'unresolvable');
  assert.equal(judgeBatches([ev]).status, 'skip');
});

test('billing: no charge at all is flagged; no successful calls is skipped', () => {
  const calls = Array.from({ length: 4 }, () => call());
  const nocharge = evaluateBatch({ calls, before: bal('5.000000'), after: { ...bal('5.000000'), settled: false, waitedMs: 8000 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.equal(nocharge.verdict, 'nocharge');
  assert.equal(judgeBatches([nocharge]).status, 'warn');
  const nodata = evaluateBatch({ calls: [call({ ok: false, expectedCost: null })], before: bal('5.000000'), after: { ...bal('5.000000'), settled: false, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.equal(judgeBatches([nodata]).status, 'skip');
});

test('billing: balance that drops without usage rising breaks conservation', () => {
  const calls = Array.from({ length: 5 }, () => call());
  const ev = evaluateBatch({ calls, before: bal('5.000000', '0'), after: { ...bal('4.995000', '0'), settled: true, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.equal(ev.conservation.ok, false);
  assert.equal(judgeBatches([ev]).status, 'warn');
});

test('billing: header chain yields per-call charges', () => {
  const calls = [
    call({ balanceHeader: D('5.000000'), balanceHeaderRaw: '5.000000' }),
    call({ balanceHeader: D('4.999000'), balanceHeaderRaw: '4.999000' }),
  ];
  const ev = evaluateBatch({ calls, before: bal('5.000000'), after: { ...bal('4.998000', '0.002000'), settled: true, waitedMs: 0 }, budgetStopped: false }, { tolerance: 0.02 });
  assert.deepEqual(ev.perCall.map((p) => p.billed), [D('0.001'), D('0.001')]);
});

/* ---------- tokens ---------- */

test('tokens: honest usage passes', () => {
  const r = evaluateTokens([call({ promptTokens: 500 }), call({ promptTokens: 501 })]);
  assert.deepEqual(r.violations, []);
});

test('tokens: catches completion over cap, bad totals and inflated prompts', () => {
  const r = evaluateTokens([
    call({ completionTokens: 99 }),
    call({ totalTokens: 900 }),
    call({ promptTokens: Math.ceil(CANARY_CHARS / 1.4) }),
  ]);
  const kinds = r.violations.map((v) => v.kind);
  assert.ok(kinds.includes('completion-over-cap'));
  assert.ok(kinds.includes('total-mismatch'));
  assert.ok(kinds.includes('prompt-inflated'));
  for (const kind of ['completion-over-cap', 'total-mismatch', 'prompt-inflated']) {
    assert.equal(r.violations.find((v) => v.kind === kind).severity, 'fail', `${kind} must be a failure`);
  }
});

test('tokens: a few tokens of provider slack warn; a large violation fails', () => {
  const slight = evaluateTokens([call({ completionTokens: 18, totalTokens: 518 })]);
  assert.ok(slight.violations.length > 0);
  assert.ok(slight.violations.every((v) => v.severity === 'warn'), 'slack must never fail the audit');
  const gross = evaluateTokens([call({ completionTokens: 400, totalTokens: 900 })]);
  assert.ok(gross.violations.some((v) => v.severity === 'fail'));
});

test('tokens: unstable counts and cross-model outliers only warn', () => {
  const c = (model, prompt) => call({ model, promptTokens: prompt, totalTokens: prompt + 2 });
  const r = evaluateTokens([c('a/x', 500), c('a/x', 520), c('b/y', 480), c('c/z', 1100)]);
  const kinds = r.violations.map((v) => v.kind);
  assert.ok(kinds.includes('unstable'));
  assert.ok(kinds.includes('cross-model-outlier'));
  assert.ok(r.violations.every((v) => v.severity === 'warn'), 'these irregularities must not fail the check');
});

/* ---------- identity ---------- */

test('identity: model names normalise across prefixes, variants and dates', () => {
  assert.equal(normalizeModelName('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModelName('claude-sonnet-5-20260601'), 'claude-sonnet-5');
  assert.equal(normalizeModelName('openai/gpt-6-mini:extended'), 'gpt-6-mini');
  assert.equal(normalizeModelName('gemini-3.8-flash-2026-08-01'), 'gemini-3-8-flash');
  assert.equal(normalizeModelName('anthropic/claude-haiku-4.5'), normalizeModelName('claude-haiku-4-5-20251001'));
});

test('identity: declaredMatch separates match, same family, mismatch and unknown', () => {
  assert.equal(declaredMatch('anthropic/claude-sonnet-5', 'claude-sonnet-5-20260601'), 'match');
  assert.equal(declaredMatch('anthropic/claude-sonnet-latest', 'claude-sonnet-5-20260601'), 'same-family');
  assert.equal(declaredMatch('anthropic/claude-sonnet-5', 'gpt-6-mini-2026-08-01'), 'mismatch');
  assert.equal(declaredMatch('acme/thing', 'other'), 'unknown');
  // dots vs dashes and dated snapshots are the same model
  assert.equal(declaredMatch('anthropic/claude-haiku-4.5', 'claude-haiku-4-5-20251001'), 'match');
  // an unfamiliar internal name is not an accusation; a different vendor's model is
  assert.equal(declaredMatch('anthropic/claude-haiku-4.5', 'internal-serving-build-7'), 'unknown');
  assert.equal(declaredMatch('anthropic/claude-haiku-4.5', 'gemini-3.8-flash'), 'mismatch');
  assert.equal(declaredMatch('a/x', null), 'unknown');
});

test('identity: repeated mismatch is mislabelling; a lone one is only a note', () => {
  const rec = (model, respModel, respId) => call({ model, respModel, respId });
  const bad = evaluateIdentity({ records: [rec('anthropic/claude-a', 'gpt-6', '1'), rec('anthropic/claude-a', 'gpt-6', '2'), rec('anthropic/claude-a', 'claude-a', '3')], fingerprints: {}, baseline: {} });
  assert.deepEqual(bad.mislabelled, ['anthropic/claude-a']);
  const lone = evaluateIdentity({ records: [rec('anthropic/claude-a', 'gpt-6', '1'), rec('anthropic/claude-a', 'claude-a', '2'), rec('anthropic/claude-a', 'claude-a', '3')], fingerprints: {}, baseline: {} });
  assert.deepEqual(lone.mislabelled, []);
  assert.deepEqual(lone.singleMismatch, ['anthropic/claude-a']);
});

test('identity: duplicate ids, unstable and indistinct fingerprints, and baseline mismatch', () => {
  const records = [call({ respId: 'same' }), call({ respId: 'same' })];
  const ev = evaluateIdentity({
    records,
    fingerprints: { 'a/x': [100, 104], 'b/y': [90, 90] },
    baseline: { 'a/x': 101 },
  });
  assert.equal(ev.duplicateIds, 1);
  assert.deepEqual(ev.unstable, ['a/x']);
  assert.equal(ev.indistinct, false);
  assert.deepEqual(ev.baselineMismatch, []); // 100 vs 101 is within the 2-token allowance
});

test('identity: identical fingerprints across vendors are indistinct', () => {
  const ev = evaluateIdentity({ records: [call({ respId: '1' })], fingerprints: { 'a/x': [90, 90], 'b/y': [90, 90] }, baseline: {} });
  assert.equal(ev.indistinct, true);
});

test('identity: baseline fingerprint difference beyond 2 tokens is a mismatch', () => {
  const ev = evaluateIdentity({ records: [call({ respId: '1' })], fingerprints: { 'a/x': [100, 100] }, baseline: { 'a/x': 140 } });
  assert.deepEqual(ev.baselineMismatch, [{ model: 'a/x', gateway: 100, direct: 140 }]);
});

/* ---------- compat ---------- */

const goodStream = () => ({ status: 200, chunks: [{ choices: [{ delta: { content: 'o' } }] }], doneSeen: true, usage: { prompt_tokens: 1 }, malformed: 0, text: 'o', firstEventMs: 5, ttfbMs: 3 });

test('compat: stream verdicts', () => {
  assert.equal(evaluateStream(goodStream()).severity, 'pass');
  assert.equal(evaluateStream({ ...goodStream(), usage: null }).severity, 'warn');
  assert.equal(evaluateStream({ ...goodStream(), doneSeen: false }).severity, 'warn');
  assert.equal(evaluateStream({ ...goodStream(), status: 500 }).severity, 'fail');
  assert.equal(evaluateStream({ ...goodStream(), chunks: [] }).severity, 'fail');
});

test('compat: tool call verdicts', () => {
  const ok = { ok: true, status: 200, text: '', json: { choices: [{ message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Lagos"}' } }] } }] } };
  assert.equal(evaluateToolCall(ok).outcome, 'ok');
  assert.equal(evaluateToolCall({ ...ok, json: { choices: [{ message: { content: 'hi' } }] } }).outcome, 'not-honored');
  const broken = { ...ok, json: { choices: [{ message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{oops' } }] } }] } };
  assert.equal(evaluateToolCall(broken).outcome, 'malformed');
  assert.equal(evaluateToolCall({ ok: false, status: 400, json: { error: { message: 'no tools' } }, text: '' }).outcome, 'error');
});

test('compat: unknown model must produce a 4xx error envelope', () => {
  assert.equal(evaluateErrorEnvelope({ status: 404, json: { error: { message: 'nope' } } }).severity, 'pass');
  assert.equal(evaluateErrorEnvelope({ status: 404, json: { detail: 'nope' } }).severity, 'warn');
  assert.equal(evaluateErrorEnvelope({ status: 200, json: {} }).severity, 'warn');
});

/* ---------- latency ---------- */

test('latency: clear pass, clear fail, and inconclusive', () => {
  const direct = [100, 102, 98, 101, 99, 100, 103, 97, 100, 101];
  const near = direct.map((x) => x + 20);
  const far = direct.map((x) => x + 90);
  assert.equal(evaluateOverhead(near, direct).verdict, 'pass');
  assert.equal(evaluateOverhead(far, direct).verdict, 'fail');
  const noisy = [100, 180, 90, 210, 95, 190, 100, 150, 120, 170];
  const verdict = evaluateOverhead(noisy.map((x) => x + 45), direct).verdict;
  assert.ok(['warn', 'pass', 'fail'].includes(verdict));
  assert.equal(evaluateOverhead([1, 2], direct).verdict, 'insufficient');
});

/* ---------- balance parsing ---------- */

test('balance: parses the Orbio and OpenRouter key shapes, never throws', () => {
  const o = parseKeyResponse({ object: 'key', balance: { currency: 'USD', available: '12.34', used: '7.66' }, rate_limit: { requests_per_minute: 120, concurrent: 32 } });
  assert.equal(o.shape, 'orbio');
  assert.equal(o.available, D('12.34'));
  assert.deepEqual(o.rateLimit, { requestsPerMinute: 120, concurrent: 32 });
  const r = parseKeyResponse({ data: { limit_remaining: 12.34, usage: 7.66 } });
  assert.equal(r.shape, 'openrouter');
  assert.equal(r.available, D('12.34'));
  assert.equal(parseKeyResponse(null).available, null);

  // Live gateway: decimals are rounded ("49.76262") but exact micro-USD is available. Prefer it.
  const live = parseKeyResponse({ balance: { currency: 'USD', available: '49.76262', used: '0.23738', available_micro_usd: '49762620', used_micro_usd: '237380' } });
  assert.equal(live.available, D('49.76262'));
  assert.equal(live.availableRaw, '49.762620', 'six places: the resolution is one micro-dollar, not one hundred-thousandth');
  assert.equal(live.usedRaw, '0.237380');
  assert.equal(parseKeyResponse({ balance: { available: '1.5', available_micro_usd: 'oops' } }).available, D('1.5'), 'bad micro field falls back');
  assert.equal(parseKeyResponse({ balance: { available: 'abc' } }).available, null);
});

/* ---------- pending charges must land before a measurement window opens ---------- */

import { waitForCharges } from '../src/checks/billing.js';

test('waitForCharges holds until earlier calls have been charged, so they cannot leak into the next batch', async () => {
  // Found while building bench: preflight calls are billed *after* they answer. If that charge
  // lands inside the next measurement window it looks like an overcharge.
  let polls = 0;
  const balances = ['5.000000', '5.000000', '5.000000', '4.999000']; // the charge lands on the 4th read
  const client = { get: async () => ({ json: { balance: { available: balances[Math.min(polls++, balances.length - 1)], used: '0' } } }) };
  const ctx = { client, config: { settleTimeoutMs: 4000, settlePollMs: 5 } };
  await waitForCharges(ctx, D('5.000000'), D('0.001'));
  assert.equal(polls, 4, 'kept polling until the balance had dropped by the expected spend');
});

test('waitForCharges gives up on a charge that never comes, instead of hanging the audit', async () => {
  const client = { get: async () => ({ json: { balance: { available: '5.000000', used: '0' } } }) };
  const started = Date.now();
  await waitForCharges({ client, config: { settleTimeoutMs: 400, settlePollMs: 10 } }, D('5.000000'), D('0.001'));
  assert.ok(Date.now() - started < 1500);
  // and does nothing when there is nothing to wait for
  await waitForCharges({ client, config: { settleTimeoutMs: 400, settlePollMs: 10 } }, D('5'), 0n);
  await waitForCharges({ client, config: { settleTimeoutMs: 400, settlePollMs: 10 } }, null, D('1'));
});

test('billed at under half the catalog price is a warning, never a silent pass', () => {
  const evals = [{ verdict: 'ok', ratio: 0.025, billed: D('0.000032'), expected: D('0.0013'), calls: 6, resolution: D('0.000001'), waitedMs: 490, conservation: { ok: true } }];
  const out = judgeBatches(evals, {});
  assert.equal(out.status, 'warn');
  assert.match(out.summary, /not confirmed/);
  // a modest, believable discount is still fine
  assert.equal(judgeBatches([{ ...evals[0], ratio: 0.9 }], {}).status, 'pass');
});
