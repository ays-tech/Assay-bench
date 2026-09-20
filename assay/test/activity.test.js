import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockGateway, MOCK_KEY } from '../src/mock/gateway.js';
import { createBenchResponder } from '../src/mock/bench-responder.js';
import { loadDataset } from '../src/bench/dataset.js';
import { SAMPLE_PATH } from '../src/bench/service.js';
import { resolveConfig } from '../src/config.js';
import { OrbioClient } from '../src/client.js';
import { runAudit } from '../src/agent.js';
import { runBench } from '../src/bench/run.js';
import { createActivityFeed, watchBalance, withFeed, emptySnapshot } from '../src/activity.js';
import { parseDecimal as D } from '../src/decimal.js';

const record = (o = {}) => ({ tag: 'shadow', source: 'gateway', model: 'a/b', ok: true, status: 200, promptTokens: 10, completionTokens: 4, expectedCost: D('0.000008'), latencyMs: 120.4, finishReason: 'stop', ...o });

/* ---------- the feed ---------- */

test('the feed keeps running totals and hands out only what is new', () => {
  const feed = createActivityFeed();
  assert.equal(feed.snapshot().active, false);
  feed.begin('bench');
  feed.onCall(record());
  feed.onCall(record({ ok: false, status: 502, promptTokens: null, completionTokens: null, expectedCost: null, error: 'HTTP 502: boom' }));
  feed.onCall(record({ model: 'c/d' }));

  const all = feed.snapshot();
  assert.equal(all.active, true);
  assert.equal(all.kind, 'bench');
  assert.equal(all.seq, 3);
  assert.deepEqual(all.totals, { calls: 3, failed: 1, promptTokens: 20, completionTokens: 8, catalogUsd: 0.000016 });
  assert.deepEqual(all.events.map((e) => e.n), [1, 2, 3]);
  assert.equal(all.events[0].latencyMs, 120);
  assert.equal(all.events[1].error, 'HTTP 502: boom');
  assert.equal(all.events[1].costUsd, null);

  assert.deepEqual(feed.snapshot(2).events.map((e) => e.n), [3], 'only events after `since`');
  assert.deepEqual(feed.snapshot(99).events, []);
  feed.end();
  assert.equal(feed.snapshot().active, false);
  assert.ok(feed.snapshot().endedAt >= feed.snapshot().startedAt);
});

test('events never carry prompts or answers, only counts and prices', () => {
  const feed = createActivityFeed();
  feed.begin('bench');
  feed.onCall(record({ content: 'SECRET CUSTOMER ANSWER', messages: [{ role: 'user', content: 'SECRET PROMPT' }] }));
  const json = JSON.stringify(feed.snapshot());
  assert.ok(!json.includes('SECRET'));
  assert.deepEqual(Object.keys(feed.snapshot().events[0]).sort(),
    ['at', 'completionTokens', 'costUsd', 'error', 'finish', 'latencyMs', 'model', 'n', 'ok', 'promptTokens', 'source', 'status', 'tag'].sort());
});

test('error text is redacted and clipped before it can reach a browser', () => {
  const feed = createActivityFeed({ redact: (t) => t.replaceAll('sk-live-123', '[redacted]') });
  feed.begin('audit');
  feed.onCall(record({ ok: false, error: `bad key sk-live-123 ${'x'.repeat(400)}` }));
  const { error } = feed.snapshot().events[0];
  assert.ok(!error.includes('sk-live-123'));
  assert.match(error, /\[redacted\]/);
  assert.ok(error.length <= 120);
});

test('the ring buffer is bounded, and starting a new run discards the old one', () => {
  const feed = createActivityFeed({ limit: 5 });
  feed.begin('audit');
  for (let i = 0; i < 20; i++) feed.onCall(record());
  const snap = feed.snapshot();
  assert.equal(snap.seq, 20);
  assert.equal(snap.totals.calls, 20, 'totals still count every call');
  assert.deepEqual(snap.events.map((e) => e.n), [16, 17, 18, 19, 20]);
  feed.begin('bench');
  assert.equal(feed.snapshot().seq, 0);
  assert.equal(feed.snapshot().totals.calls, 0);
});

test('balance drop is measured from the first reading, and scores tally per model', () => {
  const feed = createActivityFeed();
  feed.begin('bench');
  assert.equal(feed.snapshot().balance.dropUsd, null);
  feed.onBalance(5);
  feed.onBalance(4.998);
  assert.ok(Math.abs(feed.snapshot().balance.dropUsd - 0.002) < 1e-12);

  feed.onAnswer({ model: 'a/b', correct: true });
  feed.onAnswer({ model: 'a/b', correct: false });
  feed.onAnswer({ model: 'a/b', correct: null });
  assert.deepEqual(feed.snapshot().scores['a/b'], { answered: 3, scored: 2, correct: 1 });
});

test('emptySnapshot is a valid inactive snapshot', () => {
  const s = emptySnapshot();
  assert.equal(s.active, false);
  assert.equal(s.startedAt, null);
  assert.deepEqual(s.events, []);
});

/* ---------- balance watcher, withFeed ---------- */

test('watchBalance reads the starting balance first and stops promptly with a final reading', async () => {
  const reads = ['5.000000', '5.000000', '4.999000', '4.998000'];
  let i = 0;
  const client = { get: async () => ({ json: { balance: { available: reads[Math.min(i++, reads.length - 1)], used: '0' } } }) };
  const feed = createActivityFeed();
  feed.begin('audit');
  const watch = watchBalance(client, feed, { intervalMs: 20 });
  await watch.ready;
  assert.equal(feed.snapshot().balance.startUsd, 5);
  await new Promise((r) => setTimeout(r, 70));
  const t = Date.now();
  await watch.stop();
  assert.ok(Date.now() - t < 200, 'stop does not wait out a whole polling interval');
  assert.ok(feed.snapshot().balance.dropUsd > 0);
});

test('watchBalance survives a gateway that errors', async () => {
  const client = { get: async () => { throw new Error('down'); } };
  const feed = createActivityFeed();
  feed.begin('audit');
  const watch = watchBalance(client, feed, { intervalMs: 10 });
  await watch.ready;
  await watch.stop();
  assert.equal(feed.snapshot().balance.startUsd, null);
});

test('withFeed: active before the first await, ended even when the run throws, and a plain pass-through with no feed', async () => {
  const feed = createActivityFeed();
  const running = withFeed(feed, 'bench', null, async () => { throw new Error('gateway said no'); });
  assert.equal(feed.snapshot().active, true, 'active synchronously, so the dashboard sees it as soon as the request is accepted');
  await assert.rejects(running, /gateway said no/);
  assert.equal(feed.snapshot().active, false);

  assert.equal(await withFeed(null, 'audit', null, async (hooks) => { assert.deepEqual(hooks, {}); return 42; }), 42);
});

/* ---------- against the mock gateway ---------- */

test('an audit reports every gateway call to the feed, and a broken listener cannot break it', async () => {
  const gateway = await createMockGateway({ latencyMs: 1, jitterMs: 1, lagMs: 20 });
  try {
    const config = { ...resolveConfig({ key: MOCK_KEY, 'base-url': gateway.baseUrl }, {}), settleTimeoutMs: 3000, settlePollMs: 30 };
    const seen = [];
    const { report } = await runAudit({ config, onCall: (r) => seen.push(r) });
    const announced = seen.filter((r) => r.tag === 'compat');
    assert.equal(seen.length - announced.length, report.records.length, 'every recorded call reaches the listener');
    assert.ok(announced.length >= 1, 'plus the paid probes that are not part of the evidence');
    assert.ok(seen.some((r) => r.tag === 'preflight') && seen.some((r) => r.tag === 'billing'));

    const { report: again } = await runAudit({ config, onCall: () => { throw new Error('listener bug'); } });
    assert.equal(again.score.grade, 'Verified', 'the audit is unaffected by a throwing listener');
  } finally {
    await gateway.close();
  }
});

test('every paid call in an audit is in the feed: catalog total and balance drop agree', async () => {
  // Found by watching the dashboard: the streaming and tool-call probes were paid for but not reported,
  // so a healthy gateway appeared to bill 1.098x catalog. The feed must never imply that.
  const gateway = await createMockGateway({ latencyMs: 1, jitterMs: 1, lagMs: 20 });
  try {
    const config = { ...resolveConfig({ key: MOCK_KEY, 'base-url': gateway.baseUrl }, {}), settleTimeoutMs: 3000, settlePollMs: 30 };
    const client = new OrbioClient({ baseUrl: gateway.baseUrl, apiKey: MOCK_KEY });
    const feed = createActivityFeed();
    const { report } = await withFeed(feed, 'audit', client, (hooks) => runAudit({ config, onCall: hooks.onCall }));
    const snap = feed.snapshot();
    assert.ok(snap.events.some((e) => e.tag === 'compat'), 'the compat probes are reported');
    assert.ok(snap.totals.calls > report.records.length, 'the feed knows about calls the evidence records do not include');
    const ratio = snap.balance.dropUsd / snap.totals.catalogUsd;
    assert.ok(ratio > 0.98 && ratio < 1.03, `balance drop / catalog = ${ratio}`);
  } finally {
    await gateway.close();
  }
});

test('a benchmark feeds calls and per-answer scores live, and the numbers agree with the report', async () => {
  const dataset = loadDataset(SAMPLE_PATH);
  const gateway = await createMockGateway({ respond: createBenchResponder(dataset), latencyMs: 1, jitterMs: 1, lagMs: 20 });
  try {
    const config = { ...resolveConfig({ key: MOCK_KEY, 'base-url': gateway.baseUrl, 'max-spend': '5' }, {}), settleTimeoutMs: 3000, settlePollMs: 30 };
    const client = new OrbioClient({ baseUrl: gateway.baseUrl, apiKey: MOCK_KEY });
    const feed = createActivityFeed();
    const { report } = await withFeed(feed, 'bench', client, (hooks) => runBench({
      config, client, dataset, datasetName: 't', current: 'openai/gpt-6-astra',
      candidates: ['anthropic/claude-haiku-4.5', 'deepseek/deepseek-v4-flash'], rpm: 0, concurrency: 6, ...hooks,
    }));

    const snap = feed.snapshot();
    assert.equal(snap.active, false);
    const shadow = snap.events.filter((e) => e.tag === 'shadow');
    assert.equal(shadow.length, 3 * dataset.length, 'every shadow call was reported');
    assert.ok(snap.events.some((e) => e.tag === 'judge'));
    assert.ok(snap.totals.calls >= report.spend.calls);

    // live scores match the report's deterministic results for the prompts that need no judge
    for (const m of report.models) {
      const live = snap.scores[m.id];
      assert.equal(live.answered, dataset.length);
      assert.equal(live.scored, dataset.filter((it) => !it.judge).length, 'judged prompts are left for the judge, not scored live');
    }
    const cur = snap.scores['openai/gpt-6-astra'];
    assert.ok(cur.correct > 0 && cur.correct <= cur.scored);

    // the two live numbers converge: what the catalog says vs. how far the balance fell
    assert.ok(snap.balance.dropUsd > 0);
    const ratio = snap.balance.dropUsd / snap.totals.catalogUsd;
    assert.ok(ratio > 0.98 && ratio < 1.03, `balance drop / catalog = ${ratio}`);
  } finally {
    await gateway.close();
  }
});
