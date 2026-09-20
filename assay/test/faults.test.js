import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMock } from './helpers.js';
import { MOCK_KEY } from '../src/mock/gateway.js';

/**
 * End-to-end: the whole agent against a fake gateway. Every fault must be caught by the check
 * designed to catch it, and a clean gateway must score as verified.
 */

test('clean gateway: everything verifies, score is top grade, key never leaks', async () => {
  const { report, byId } = await auditMock();
  for (const id of ['auth', 'catalog', 'billing', 'identity', 'tokens', 'compat']) assert.equal(byId[id].status, 'pass', `${id}: ${byId[id].summary}`);
  assert.equal(byId.latency.status, 'info');
  assert.equal(report.score.fineness, 1000);
  assert.equal(report.score.grade, 'Verified');
  assert.equal(report.schema, 'assay.report/1');
  assert.ok(report.spend.calls >= 12);
  assert.ok(Number(report.spend.actualUsd) < Number(report.spend.capUsd), 'must stay under the cap');
  assert.ok(!JSON.stringify(report).includes(MOCK_KEY), 'API key must never appear in a report');
});

test('overcharging is confirmed on a second batch and fails billing', async () => {
  const { report, byId } = await auditMock({ faults: ['overcharge'] });
  assert.equal(byId.billing.status, 'fail');
  assert.equal(byId.billing.measured.batches, 2);
  assert.ok(byId.billing.details.batches.every((b) => b.verdict === 'over'));
  assert.ok(report.score.capped);
  assert.equal(report.score.fineness, 600);
});

test('model substitution fails identity and nothing else', async () => {
  const { byId } = await auditMock({ faults: ['swap'] });
  assert.equal(byId.identity.status, 'fail');
  assert.match(byId.identity.summary, /different model/);
  assert.equal(byId.billing.status, 'pass');
});

test('self-consistent token inflation is caught by token accounting, not billing', async () => {
  const { byId } = await auditMock({ faults: ['inflate'] });
  assert.equal(byId.billing.status, 'pass', 'billing is internally consistent, so it must pass');
  assert.equal(byId.tokens.status, 'fail');
});

test('slow charge settlement is waited out, not mistaken for free usage', async () => {
  const { byId } = await auditMock({ faults: ['lag'], config: { settleTimeoutMs: 6000 } });
  assert.equal(byId.billing.status, 'pass', byId.billing.summary);
  assert.ok(byId.billing.measured.settleWaitMs >= 1000);
  // The real regression: it once passed while measuring 2.5% of the charge, because stray earlier
  // charges satisfied "the balance changed and stopped moving". The ratio must be the true one.
  assert.ok(byId.billing.measured.ratio > 0.97 && byId.billing.measured.ratio < 1.03, `ratio=${byId.billing.measured.ratio}`);
});

test('coarse balance precision skips billing honestly and withholds the top grade', async () => {
  const { report, byId } = await auditMock({ faults: ['coarse'] });
  assert.equal(byId.billing.status, 'skip');
  assert.match(byId.billing.summary, /precision/);
  assert.equal(report.score.grade, 'Partially verified');
  assert.match(report.headline, /Billing could not be verified/);
});

test('accepting an invalid key is an auth failure that caps the score', async () => {
  const { report, byId } = await auditMock({ faults: ['noauthcheck'] });
  assert.equal(byId.auth.status, 'fail');
  assert.ok(report.score.fineness <= 600);
});

test('missing stream usage and ignored tool_choice are compatibility warnings, not failures', async () => {
  const a = await auditMock({ faults: ['nostreamusage'] });
  assert.equal(a.byId.compat.status, 'warn');
  assert.match(a.byId.compat.summary, /usage/);
  const b = await auditMock({ faults: ['notools'] });
  assert.equal(b.byId.compat.status, 'warn');
  assert.match(b.byId.compat.summary, /tool/);
});

test('per-million pricing is detected and billing still reconciles', async () => {
  const { report, byId } = await auditMock({ mock: { priceUnit: 'per_million' } });
  assert.equal(report.gateway.priceUnit, 'per_million');
  assert.equal(byId.billing.status, 'pass', byId.billing.summary);
});

test('the spend cap is enforced and reported', async () => {
  const { report, byId } = await auditMock({ config: { maxSpend: 4_000_000_000_000n } }); // $0.000004
  assert.ok(Number(report.spend.actualUsd ?? 0) <= 0.001);
  assert.ok(['skip', 'warn'].includes(byId.billing.status));
});

test('a rejected credential stops the audit cleanly instead of crashing', async () => {
  const { createMockGateway } = await import('../src/mock/gateway.js');
  const { resolveConfig } = await import('../src/config.js');
  const { runAudit } = await import('../src/agent.js');
  const gw = await createMockGateway();
  try {
    const config = resolveConfig({ key: 'sk-wrong-key-123456', 'base-url': gw.baseUrl }, {});
    const { report } = await runAudit({ config });
    assert.equal(report.checks[0].status, 'fail');
    assert.ok(report.checks.slice(2).every((c) => c.status === 'skip'));
    assert.equal(gw.state.requests, 0, 'no paid calls may be made with a rejected key');
  } finally {
    await gw.close();
  }
});

test('an unreachable gateway is reported as such', async () => {
  const { resolveConfig } = await import('../src/config.js');
  const { runAudit } = await import('../src/agent.js');
  const config = { ...resolveConfig({ key: MOCK_KEY, 'base-url': 'http://127.0.0.1:1/api/v1' }, {}), timeoutMs: 1500 };
  const { report } = await runAudit({ config });
  assert.equal(report.checks[0].status, 'fail');
  assert.match(report.checks[0].summary, /reach the gateway/);
});

test('baseline: a heavy gateway hop fails the latency claim; a light one passes', async () => {
  const heavy = await auditMock({ mock: { overheadMs: 110 }, baseline: {} });
  assert.equal(heavy.byId.latency.status, 'fail', heavy.byId.latency.summary);
  const light = await auditMock({ baseline: {} });
  assert.equal(light.byId.latency.status, 'pass', light.byId.latency.summary);
  assert.equal(light.byId.identity.status, 'pass');
  assert.ok(light.byId.identity.measured.baselineCompared >= 1);
});

test('baseline: tokenizer fingerprint that differs from the direct provider fails identity', async () => {
  const { byId } = await auditMock({ faults: ['swap'], baseline: {} });
  assert.equal(byId.identity.status, 'fail');
});

test('a model that cannot answer is skipped, reported, and replaced — never silently counted', async () => {
  // Found live: two of three audit models failed, yet the report claimed three vendors and 1000.
  const { report, byId } = await auditMock({ mock: { brokenModels: ['openai/gpt-6-mini'] } });
  assert.deepEqual(report.plan.skipped.map((s) => s.id), ['openai/gpt-6-mini']);
  assert.match(report.plan.skipped[0].error, /502/);
  assert.equal(report.models.length, 3, 'replaced with the next candidate');
  assert.ok(!report.models.includes('openai/gpt-6-mini'));
  assert.equal(byId.catalog.status, 'warn');
  assert.match(byId.catalog.summary, /Skipped 1 that failed preflight/);
  assert.equal(byId.billing.status, 'pass');
  assert.match(byId.identity.summary, /across 3 vendors/);
});

test('when only one vendor can answer, identity says so instead of claiming distinct fingerprints', async () => {
  const broken = ['openai/gpt-6-mini', 'openai/gpt-6-astra', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4-flash', 'x-ai/grok-4.6'];
  const { report, byId } = await auditMock({ mock: { brokenModels: broken } });
  assert.deepEqual([...new Set(report.models.map((m) => m.split('/')[0]))], ['anthropic']);
  assert.equal(byId.identity.status, 'warn');
  assert.match(byId.identity.summary, /only 1 vendor responded/);
  assert.notEqual(report.score.grade, 'Verified');
});

test('exact micro-USD balances resolve costs the rounded decimals could not', async () => {
  const { byId } = await auditMock();
  // six places = one micro-dollar of resolution
  assert.equal(byId.billing.measured.balanceResolution, '0.000001000');
});
