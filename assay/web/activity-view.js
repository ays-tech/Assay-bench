import { h, s, clear } from './dom.js';

/* The live activity panel. It shows what an audit or benchmark is doing right now, and the two
   numbers that are the whole point of Assay: what the catalog says the calls cost, and how far your
   balance has actually dropped. Charges land after the call they pay for, so the balance trails the
   catalog at first, and watching the two meet is the audit, made visible.

   It only ever receives counts and prices. It never sees a prompt or an answer. */

const AV_ROWS = 6;
const AV_TITLE = { audit: ['Auditing the gateway', 'Audit complete'], bench: ['Benchmarking models', 'Benchmark complete'] };

const avUsd = (n) => (n === null || n === undefined ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`);
const avShort = (id) => id.split('/').pop();
const avClock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** A horizontal bar whose width is set with an attribute (allowed by the page's strict CSP). */
function avBar(kind) {
  const fill = s('rect', { class: `av-fill ${kind}`, x: 0, y: 0, width: 0, height: 6, rx: 3 });
  return { fill, svg: s('svg', { class: 'av-bar', viewBox: '0 0 100 6', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, s('rect', { class: 'av-track', x: 0, y: 0, width: 100, height: 6, rx: 3 }), fill) };
}

/**
 * @param {HTMLElement} root the (initially hidden) container
 * @returns {{update: (snapshot: any) => void, reset: () => void}}
 */
export function createActivityPanel(root) {
  /** @type {any[]} */
  let recent = [];

  const title = h('h2', { class: 'av-title' }, '');
  const clock = h('span', { class: 'av-clock' }, '0:00');
  const hide = h('button', { class: 'av-hide', type: 'button', 'aria-label': 'Hide live activity', onClick: () => { root.hidden = true; } }, '×');
  const summary = h('p', { class: 'av-summary' }, '');

  const catalogValue = h('b', {}, '$0');
  const balanceValue = h('b', {}, 'reading…');
  const catalogBar = avBar('catalog');
  const balanceBar = avBar('balance');
  const verdict = h('p', { class: 'av-verdict' }, '');

  const scoresTitle = h('p', { class: 'av-sub' }, 'Correct so far');
  const scores = h('div', { class: 'av-scores' });
  const scoresBox = h('div', { hidden: true }, scoresTitle, scores,
    h('p', { class: 'av-verdict' }, 'Hard checks only. Fuzzy answers are scored by the judge at the end.'));

  const log = h('ol', { class: 'av-log', 'aria-hidden': 'true' });
  const status = h('p', { class: 'sr', role: 'status' }, '');

  root.append(
    h('div', { class: 'av-head' }, h('span', { class: 'av-dot', 'aria-hidden': 'true' }), title, clock, hide),
    summary,
    h('div', { class: 'av-money' },
      h('div', { class: 'av-row' }, h('span', {}, 'Catalog says'), catalogValue, catalogBar.svg),
      h('div', { class: 'av-row' }, h('span', {}, 'Your balance dropped'), balanceValue, balanceBar.svg)),
    verdict, scoresBox,
    h('p', { class: 'av-sub' }, 'Latest calls'), log, status);

  let lastState = '';

  return {
    reset() {
      recent = [];
      clear(log);
      clear(scores);
      scoresBox.hidden = true;
      lastState = '';
      root.hidden = true;
    },

    update(snap) {
      if (snap.startedAt === null) return;
      const finished = !snap.active;
      root.hidden = false;
      root.dataset.state = finished ? 'done' : 'live';

      const [liveTitle, doneTitle] = AV_TITLE[snap.kind] ?? AV_TITLE.audit;
      title.textContent = finished ? doneTitle : liveTitle;
      clock.textContent = avClock(Math.max(0, Math.round(((finished ? snap.endedAt : Date.now()) - snap.startedAt) / 1000)));

      const t = snap.totals;
      summary.textContent = `${t.calls} calls · ${(t.promptTokens + t.completionTokens).toLocaleString()} tokens${t.failed ? ` · ${t.failed} failed` : ''}`;

      // The two numbers, on one scale so the bars are directly comparable.
      const drop = snap.balance.dropUsd === null ? null : Math.max(0, snap.balance.dropUsd);
      const top = Math.max(t.catalogUsd, drop ?? 0, 1e-9);
      catalogValue.textContent = avUsd(t.catalogUsd);
      balanceValue.textContent = drop === null ? 'reading…' : avUsd(drop);
      catalogBar.fill.setAttribute('width', String((t.catalogUsd / top) * 100));
      balanceBar.fill.setAttribute('width', String(((drop ?? 0) / top) * 100));

      if (!finished) verdict.textContent = 'A charge lands after the call it pays for, so the balance trails the catalog at first. Watch them meet.';
      else if (drop !== null && t.catalogUsd > 0) {
        verdict.textContent = drop > 0
          ? `Billed ${(drop / t.catalogUsd).toFixed(3)}× the catalog price across ${t.calls} calls.`
          : 'No balance movement was seen: a free grant, or nothing was billed.';
      } else verdict.textContent = 'Finished.';

      // Bench: per-model scoreboard, filling as answers are checked.
      const rows = Object.entries(snap.scores ?? {});
      scoresBox.hidden = rows.length === 0;
      if (rows.length) {
        clear(scores);
        for (const [model, sc] of rows) {
          const bar = avBar('score');
          bar.fill.setAttribute('width', String(sc.scored ? (sc.correct / sc.scored) * 100 : 0));
          scores.append(h('div', { class: 'av-score-row' }, h('span', { class: 'av-model' }, avShort(model)), bar.svg, h('span', { class: 'av-count' }, `${sc.correct}/${sc.scored}`)));
        }
      }

      // The most recent calls, newest first.
      recent = [...recent, ...snap.events].slice(-AV_ROWS);
      clear(log);
      for (const ev of [...recent].reverse()) {
        log.append(h('li', { 'data-ok': String(ev.ok), title: ev.error ?? '' },
          h('span', { class: 'av-tag' }, ev.tag),
          h('span', { class: 'av-model' }, avShort(ev.model)),
          h('span', { class: 'av-tok' }, `${ev.promptTokens ?? '–'}→${ev.completionTokens ?? '–'}`),
          h('span', { class: 'av-cost' }, ev.costUsd === null ? '—' : avUsd(ev.costUsd)),
          h('span', { class: 'av-ms' }, `${ev.latencyMs} ms`),
          h('span', { class: 'av-ok' }, ev.ok ? '✓' : '✕')));
      }

      // Announce only the outcome, once. A feed that speaks every call would be unusable with a screen reader.
      const state = finished ? `done-${snap.kind}` : 'live';
      if (state !== lastState) {
        lastState = state;
        status.textContent = finished ? `${doneTitle}. ${verdict.textContent}` : '';
      }
    },
  };
}
