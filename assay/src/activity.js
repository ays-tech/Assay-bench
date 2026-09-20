import { readBalance } from './checks/balance.js';

/**
 * Live activity for a running audit or benchmark: one event per real gateway call, plus the two
 * numbers that are the whole point of Assay, side by side. What the catalog says the calls cost, and
 * how far your balance has actually dropped.
 *
 * Events carry counts and prices only. Prompts and answers never enter the feed.
 */

const USD = 1e18; // decimal.js fixed-point scale

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const fresh = () => ({
  active: false, kind: null, startedAt: null, endedAt: null, seq: 0, events: [],
  totals: { calls: 0, failed: 0, promptTokens: 0, completionTokens: 0, catalogUsd: 0 },
  balance: { startUsd: null, nowUsd: null },
  scores: {},
});

/** What `/api/activity` returns when nothing is running. */
export const emptySnapshot = () => snapshotOf(fresh(), 0, 0);

function snapshotOf(s, since, limit) {
  const { startUsd, nowUsd } = s.balance;
  return {
    active: s.active, kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt, seq: s.seq,
    totals: { ...s.totals },
    balance: { startUsd, nowUsd, dropUsd: startUsd !== null && nowUsd !== null ? startUsd - nowUsd : null },
    scores: Object.fromEntries(Object.entries(s.scores).map(([k, v]) => [k, { ...v }])),
    events: s.events.filter((e) => e.n > since).slice(-limit),
  };
}

/**
 * @param {{limit?: number, redact?: (text: string) => string}} [opts]
 */
export function createActivityFeed({ limit = 400, redact = (t) => t } = {}) {
  let s = fresh();
  return {
    /** Start a new run; anything from the previous one is discarded. @param {'audit'|'bench'} kind */
    begin(kind) {
      s = fresh();
      s.active = true;
      s.kind = kind;
      s.startedAt = Date.now();
    },
    end() {
      s.active = false;
      s.endedAt = Date.now();
    },
    /** @param {import('./probe.js').CallRecord} record */
    onCall(record) {
      const costUsd = record.expectedCost === null || record.expectedCost === undefined ? null : Number(record.expectedCost) / USD;
      s.events.push({
        n: ++s.seq, at: Date.now(), tag: record.tag, source: record.source, model: record.model, ok: record.ok, status: record.status,
        promptTokens: record.promptTokens, completionTokens: record.completionTokens, costUsd, latencyMs: Math.round(record.latencyMs),
        finish: record.finishReason ?? null,
        error: record.ok ? null : clip(redact(String(record.error ?? 'failed')), 120),
      });
      if (s.events.length > limit) s.events.splice(0, s.events.length - limit);
      const t = s.totals;
      t.calls += 1;
      if (!record.ok) t.failed += 1;
      t.promptTokens += record.promptTokens ?? 0;
      t.completionTokens += record.completionTokens ?? 0;
      t.catalogUsd += costUsd ?? 0;
    },
    /** Bench only: an answer arrived and was checked. `correct` is null when a judge has yet to decide. */
    onAnswer({ model, correct }) {
      const row = (s.scores[model] ??= { answered: 0, scored: 0, correct: 0 });
      row.answered += 1;
      if (correct !== null) {
        row.scored += 1;
        if (correct) row.correct += 1;
      }
    },
    /** @param {number} usd balance as read from the gateway */
    onBalance(usd) {
      if (s.balance.startUsd === null) s.balance.startUsd = usd;
      s.balance.nowUsd = usd;
    },
    /** @param {number} [since] only events after this sequence number */
    snapshot(since = 0) {
      return snapshotOf(s, since, 250);
    },
  };
}

/**
 * Poll the balance while a run is going, so the dashboard can show the balance drop converging on the
 * catalog price. GET /key is free and read-only. `ready` resolves once the starting balance is known.
 *
 * @param {import('./client.js').OrbioClient} client
 * @param {ReturnType<typeof createActivityFeed>} feed
 * @param {{intervalMs?: number}} [opts]
 */
export function watchBalance(client, feed, { intervalMs = 1500 } = {}) {
  let stopped = false;
  let wake = () => {};
  const poll = async () => {
    try {
      const reading = await readBalance(client);
      if (reading.available !== null) feed.onBalance(Number(reading.available) / USD);
    } catch { /* a missed reading only makes the line coarser */ }
  };
  const nap = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const ready = poll();
  const loop = (async () => {
    await ready;
    while (!stopped) {
      await nap(intervalMs);
      if (!stopped) await poll();
    }
  })();
  return {
    ready,
    /** Stop polling and take one last reading, so the final figure is what the balance ended at. */
    async stop() {
      stopped = true;
      wake();
      await loop;
      await poll();
    },
  };
}

/**
 * Run `fn` with the feed recording it. Handles begin/end and the balance watcher, and is a plain
 * pass-through when there is no feed, so callers need no special cases.
 *
 * @template T
 * @param {ReturnType<typeof createActivityFeed>|null} feed
 * @param {'audit'|'bench'} kind
 * @param {import('./client.js').OrbioClient|null} client
 * @param {(hooks: {onCall?: Function, onAnswer?: Function}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFeed(feed, kind, client, fn) {
  if (!feed) return fn({});
  feed.begin(kind); // synchronous: the run is "active" before the HTTP request that started it is answered
  const watch = client ? watchBalance(client, feed) : null;
  try {
    await watch?.ready;
    return await fn({ onCall: feed.onCall, onAnswer: feed.onAnswer });
  } finally {
    await watch?.stop();
    feed.end();
  }
}
