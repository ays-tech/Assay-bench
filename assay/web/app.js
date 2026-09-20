import {
  BOOK_SNAPSHOT, HEADLINE_DISCOUNT, PLATFORM_FEE, estimateWorkload, fmtUsd, fmtPct, breakEvenDiscount,
} from './pricing.js';
import { h, s, $, clear } from './dom.js';
import { renderBenchView } from './bench-view.js';
import { renderHome } from './home-view.js';
import { createActivityPanel } from './activity-view.js';

let activity = null;
let tracking = false;
const state = { report: null, history: [], catalog: [], canRun: false, static: false, generatedAt: null, bench: null, canBench: false, datasets: [] };

const STATUS_WORD = { pass: 'Verified', warn: 'Review', fail: 'Failed', skip: 'Not run', info: 'Measured' };

/* ---------- boot ---------- */

async function boot() {
  const embedded = document.getElementById('assay-data');
  try {
    if (embedded) {
      Object.assign(state, JSON.parse(embedded.textContent ?? '{}'), { static: true });
    } else {
      await refresh();
    }
  } catch (err) {
    $('#report-root').replaceChildren(h('p', { class: 'status-line error' }, `Could not load data: ${err.message}`));
    return;
  }
  const runBtn = $('#run-btn');
  runBtn.addEventListener('click', startRun);
  loadEst();
  activity = createActivityPanel($('#activity'));
  window.addEventListener('hashchange', () => route(true));
  if (state.static) {
    $('#foot-note').textContent = `Static scorecard generated ${new Date(state.generatedAt ?? Date.now()).toLocaleString()}. Assay is an independent tool built for the Orbio agent hackathon; it is not operated by Orbio.`;
  }
  renderAll();
  route(false);
}

/* ---------- views ---------- */

const VIEWS = ['home', 'audit', 'bench', 'estimator', 'method'];
const currentView = () => {
  const name = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(name) ? name : 'home';
};

function route(moveFocus) {
  const view = currentView();
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== view;
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('#run-btn').hidden = !(view === 'audit' && state.canRun);
  if (moveFocus) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const heading = document.querySelector('[data-view]:not([hidden]) h1, [data-view]:not([hidden]) h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
}

async function refresh() {
  const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  Object.assign(state, await res.json());
}

function renderAll() {
  renderHome($('#home-root'), { state });
  renderPill();
  renderReport();
  renderEvidence();
  renderEstimator();
  renderBenchView($('#bench-root'), {
    state, refresh, rerender: renderAll, trackActivity,
    pricing: () => ({ discount: est.discountPct / 100, fee: est.feePct / 100 }),
    openInEstimator,
  });
}

/** Header pill: which gateway, and how far it was trusted at the last audit. */
function renderPill() {
  const pill = $('#gw-pill');
  const report = state.report;
  pill.hidden = !report;
  if (!report) return;
  clear(pill);
  pill.append(report.gateway.host, report.score.fineness !== null && h('small', {}, `· ${report.score.fineness}`));
}

/** Bench hands its measured workload to the estimator, so the two views agree. */
function openInEstimator(rows) {
  est.rows = rows;
  est.mode = 'fixed';
  saveEst();
  location.hash = '#/estimator';
  renderEstimator();
}

/* ---------- live activity ---------- */

/**
 * Follow the running audit or benchmark in the docked panel until it finishes. The feed is a
 * nicety: if it fails for any reason the run itself carries on untouched.
 */
async function trackActivity() {
  if (state.static || tracking || !activity) return;
  tracking = true;
  activity.reset();
  let since = 0;
  let idle = 0;
  try {
    // Closing the panel only hides the feed; the run carries on and its own status line still reports it.
    while (!activity.dismissed()) {
      const snap = await (await fetch(`/api/activity?since=${since}`)).json();
      since = snap.seq;
      if (snap.startedAt === null) {
        if (++idle >= 3) break; // nothing is running
      } else {
        activity.update(snap);
        if (!snap.active) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch { /* ignore */ } finally {
    tracking = false;
  }
}

/* ---------- running an audit ---------- */

function setStatus(message, isError = false) {
  const el = $('#run-status');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
}

async function startRun() {
  const btn = $('#run-btn');
  btn.disabled = true;
  setStatus('Starting…');
  try {
    const res = await fetch('/api/run', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(body.error ?? `HTTP ${res.status}`);
    trackActivity();
    await pollRun();
    await refresh();
    renderAll();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function pollRun() {
  for (;;) {
    const res = await fetch('/api/run/status');
    const st = await res.json();
    setStatus(st.error ? `Audit failed: ${st.error}` : st.message, Boolean(st.error));
    if (!st.running) {
      if (st.error) throw new Error(st.error);
      return;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

/* ---------- hero ---------- */

const SHIELD = 'M30 6H270Q294 6 294 30V236C294 290 220 322 150 336C80 322 6 290 6 236V30Q6 6 30 6Z';

function hallmark(score, ghost = false) {
  const text = score.fineness === null ? '—' : String(score.fineness);
  return s('svg', { class: `hallmark stamp${ghost ? ' ghost' : ''}`, viewBox: '0 0 300 340', role: 'img', 'aria-label': `Fineness ${text} out of 1000. ${score.grade}.` },
    s('path', { class: 'shield-fill', d: SHIELD }),
    s('path', { class: 'shield-inner', d: SHIELD, transform: 'translate(150 171) scale(0.925) translate(-150 -171)' }),
    s('path', { class: 'shield-edge', d: SHIELD }),
    s('path', { class: 'punch', d: 'M150 42l9 9-9 9-9-9z' }),
    // textLength pins the width, so a wider fallback font is squeezed instead of overflowing the shield.
    s('text', { class: 'num', x: 150, y: 180, 'font-size': text.length >= 4 ? 120 : 140, textLength: Math.min(200, text.length * 52), lengthAdjust: 'spacingAndGlyphs' }, text),
    s('text', { class: 'sub', x: 150, y: 214 }, 'parts per thousand'),
    s('text', { class: 'grade', x: 150, y: 264 }, score.grade));
}

function renderReport() {
  const root = $('#report-root');
  clear(root);
  const report = state.report;

  if (!report) {
    root.append(h('div', { class: 'split empty' },
      h('div', {},
        h('h1', { id: 'verdict', class: 'verdict' }, 'No audit yet.'),
        h('p', { class: 'lede' }, 'Assay spends a few cents on fixed test prompts and compares what the gateway says with what your balance does.'),
        state.canRun
          ? h('div', { class: 'hero-actions' }, h('p', { id: 'run-status', class: 'status-line' }, 'Press Run audit, top right, to start.'))
          : h('p', {}, 'Run ', h('code', { class: 'cmd' }, 'assay run'), ' in your terminal, then reload.')),
      h('div', { class: 'card stamp-card' }, hallmark({ fineness: null, grade: 'Not yet audited' }, true))));
    return;
  }

  const { score } = report;
  const spend = report.spend.actualUsd ?? report.spend.expectedUsd;
  const ran = report.checks.filter((c) => ['pass', 'warn', 'fail'].includes(c.status)).length;

  root.append(
    h('div', { class: 'split' },
      h('div', {},
        h('h1', { id: 'verdict', class: 'verdict' }, report.headline),
        report.narrative && h('p', { class: 'narrative' }, report.narrative.text),
        report.narrative && h('p', { class: 'narrative-note' }, `Written by ${report.narrative.model} from this report's evidence. Every number in it is checked against the results.`),
        h('dl', { class: 'facts' },
          fact('Paid calls', String(report.spend.calls)),
          fact('Spent', fmtUsd(Number(spend)), spend === report.spend.actualUsd ? 'balance' : 'est.'),
          fact('Models', String(report.models.length)),
          fact('Coverage', `${Math.round(score.coverage * 100)}%`, `${ran} of ${report.checks.length} checks`)),
        h('div', { class: 'hero-actions' },
          h('p', { id: 'run-status', class: 'status-line' },
            `Audited ${new Date(report.finishedAt).toLocaleString()} against ${report.gateway.host}${score.capped ? '. Score capped: an integrity check failed.' : ''}`)),
        h('p', { class: 'next' },
          score.fineness !== null && score.fineness >= 800
            ? ['Gateway checked. ', h('a', { href: '#/bench' }, 'Next: find the cheapest model that is good enough for your prompts.')]
            : 'Treat any benchmark on this gateway with caution until the failing checks are resolved.')),
      h('div', { class: 'card stamp-card' }, hallmark(score))),
    ledger(report));
}

function fact(label, value, small) {
  return h('div', {}, h('dt', {}, label), h('dd', {}, value, small && h('small', {}, small)));
}

/* ---------- ledger ---------- */

const GLYPH = {
  pass: () => [s('circle', { class: 'fill', cx: 12, cy: 12, r: 10 }), s('path', { class: 'mark', d: 'M7 12.5l3.2 3.2L17 8.8' })],
  warn: () => [s('path', { class: 'fill', d: 'M12 3L22 20H2z', 'stroke-linejoin': 'round' }), s('path', { class: 'mark', d: 'M12 9.5v4.5M12 17v.4' })],
  fail: () => [s('rect', { class: 'fill', x: 3, y: 3, width: 18, height: 18, rx: 3 }), s('path', { class: 'mark', d: 'M8.5 8.5l7 7M15.5 8.5l-7 7' })],
  skip: () => [s('circle', { class: 'fill', cx: 12, cy: 12, r: 10 }), s('path', { class: 'mark', d: 'M8 12h8' })],
  info: () => [s('path', { class: 'fill', d: 'M12 2L22 12L12 22L2 12z', 'stroke-linejoin': 'round' }), s('path', { class: 'mark', d: 'M12 11v5M12 8v.4' })],
};

function glyph(status) {
  return s('svg', { class: 'glyph', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ...(GLYPH[status] ?? GLYPH.skip)());
}

/** The one number that best summarises a check, plus what it is a number of. */
export function figureFor(check) {
  const m = check.measured ?? {};
  switch (check.id) {
    case 'billing':
      return typeof m.ratio === 'number' ? [`${m.ratio.toFixed(3)}×`, 'of catalog price'] : ['—', 'not resolved'];
    case 'tokens':
      return [String(m.violations ?? '—'), `irregularities in ${m.calls ?? 0} calls`];
    case 'identity':
      return [String(m.responses ?? '—'), 'responses checked'];
    case 'compat': {
      const items = check.details?.items ?? [];
      return items.length ? [`${items.filter((i) => i.severity === 'pass').length}/${items.length}`, 'probes passed'] : ['—', ''];
    }
    case 'latency':
      if (typeof m.overheadMs === 'number') return [`${m.overheadMs >= 0 ? '+' : '−'}${Math.abs(m.overheadMs)} ms`, 'vs direct'];
      return typeof m.floorP50 === 'number' ? [`${m.floorP50} ms`, 'gateway round-trip'] : ['—', ''];
    case 'auth':
      return m.available !== undefined ? [fmtUsd(Number(m.available)), 'balance'] : ['—', ''];
    case 'catalog':
      return [String(m.models ?? '—'), 'models listed'];
    default:
      return ['', ''];
  }
}

function ledger(report) {
  return h('div', { class: 'ledger', role: 'list', 'aria-label': 'Checks' },
    report.checks.map((check) => {
      const [figure, caption] = figureFor(check);
      const evidence = JSON.stringify({ measured: check.measured ?? {}, details: check.details ?? {} }, null, 2);
      return h('details', { class: 'check', 'data-status': check.status, role: 'listitem', open: check.status === 'fail' },
        h('summary', {},
          h('span', { class: 'status' }, glyph(check.status), STATUS_WORD[check.status] ?? check.status),
          h('div', {},
            h('p', { class: 'check-title' }, check.title),
            h('p', { class: 'check-summary' }, check.summary)),
          h('div', { class: 'figure' }, figure, caption && h('small', {}, caption))),
        h('div', { class: 'check-body' },
          h('div', {}, h('h4', {}, 'How it is tested'), h('p', {}, check.method)),
          h('div', {}, h('h4', {}, 'What it cannot prove'), h('p', {}, check.limits)),
          h('div', {}, h('h4', {}, `Evidence (${check.durationMs} ms)`),
            h('pre', { class: 'evidence-json', tabindex: 0 }, evidence.length > 6000 ? `${evidence.slice(0, 6000)}\n…` : evidence))));
    }));
}

/* ---------- evidence charts ---------- */

function renderEvidence() {
  const section = $('#evidence');
  const root = $('#evidence-root');
  clear(root);
  const report = state.report;
  section.hidden = !report;
  if (!report) return;
  root.append(billingChart(report), latencyChart(report));
  if (state.history.length >= 2) root.append(historyChart(state.history));
}

const W = 520;

function chartFrame(title, blurb, svg) {
  return h('figure', { class: 'chart' }, h('h3', {}, title), h('p', {}, blurb), svg);
}

function billingChart(report) {
  const title = 'Billed against catalog price';
  const calls = report.records.filter((r) => r.tag === 'billing' && r.ok && r.expectedUsd !== null);
  const chained = calls.length >= 2 && calls.every((r) => r.billedUsd !== null);
  const ratio = report.checks.find((c) => c.id === 'billing')?.measured?.ratio;
  const empty = (msg) => chartFrame(title, msg, s('svg', { viewBox: `0 0 ${W} 30`, role: 'img', 'aria-label': 'No data' }));
  if (!chained) return empty('No per-call billing data on this run: the billing check could not resolve individual charges.');

  // Cumulative totals: a charge that lands one call late shifts the individual steps but not the running total.
  let e = 0, b = 0;
  const expected = [], billed = [];
  for (const r of calls) {
    e += Number(r.expectedUsd); b += Number(r.billedUsd);
    expected.push(e); billed.push(b);
  }
  const H = 240, L = 62, R = 96, T = 14, B = 32;
  const yMax = Math.max(e, b, 1e-12) * 1.1;
  const x = (i) => L + (i * (W - L - R)) / (calls.length - 1);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const path = (xs) => xs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Cumulative cost over ${calls.length} paid calls. Expected from catalog prices: ${fmtUsd(e)}. Billed by the balance: ${fmtUsd(b)}${typeof ratio === 'number' ? `, ${ratio.toFixed(3)} times the catalog price` : ''}.` },
    ...[0, 0.5, 1].map((f) => [
      s('line', { class: f === 0 ? 'axis' : 'grid', x1: L, x2: W - R, y1: y(f * yMax / 1.1), y2: y(f * yMax / 1.1) }),
      s('text', { x: L - 8, y: y(f * yMax / 1.1) + 4, 'text-anchor': 'end' }, fmtUsd(f * yMax / 1.1))]),
    s('path', { class: 'line', d: path(expected) }),
    s('path', { class: 'line thin', d: path(billed) }),
    ...billed.map((v, i) => s('circle', { class: 'dot', cx: x(i), cy: y(v), r: 4.5, fill: 'var(--sheet)', stroke: 'var(--ink)' })),
    s('text', { x: W - R + 8, y: y(e) - 6 }, 'expected'),
    s('text', { x: W - R + 8, y: y(e) + 7 }, 'from catalog'),
    s('text', { x: W - R + 8, y: y(b) + (Math.abs(y(b) - y(e)) < 22 ? 30 : 4) }, 'billed'),
    s('text', { x: L, y: H - 8 }, 'call 1'),
    s('text', { x: W - R, y: H - 8, 'text-anchor': 'end' }, `call ${calls.length}`));

  return chartFrame(title,
    `Running total of what the catalog says the calls cost (line) against what the balance actually lost (dots)${typeof ratio === 'number' ? `. Final ratio ${ratio.toFixed(3)}×.` : '.'} They should end together.`, svg);
}

function latencyChart(report) {
  const title = 'Response time per model';
  const byModel = {};
  for (const r of report.records) if (r.tag === 'billing' && r.ok && r.source === 'gateway') (byModel[r.model] ??= []).push(r.latencyMs);
  const models = Object.keys(byModel);
  if (!models.length) return chartFrame(title, 'No successful calls to time.', s('svg', { viewBox: `0 0 ${W} 40`, role: 'img', 'aria-label': 'No data' }));

  const floor = report.checks.find((c) => c.id === 'latency')?.measured?.floorP50;
  const all = models.flatMap((m) => byModel[m]);
  const xMax = Math.max(...all, floor ?? 0) * 1.08 || 1;
  const L = 150, R = 14, rowH = 40, T = 10, B = 30;
  const H = T + models.length * rowH + B;
  const x = (v) => L + (v / xMax) * (W - L - R);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Response times for ${models.length} models. ${models.map((m) => `${m}: median ${Math.round(median(byModel[m]))} milliseconds`).join('; ')}.` },
    s('line', { class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B }),
    ...[0, 0.5, 1].map((f) => s('text', { x: x(f * xMax), y: H - 10, 'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle' }, `${Math.round(f * xMax)} ms`)),
    typeof floor === 'number' && [
      s('line', { class: 'grid', x1: x(floor), x2: x(floor), y1: T, y2: H - B, 'stroke-dasharray': '4 3' }),
      s('text', { x: x(floor) + 4, y: T + 10 }, 'gateway round-trip')],
    ...models.map((m, i) => {
      const cy = T + i * rowH + rowH / 2;
      const label = m.length > 24 ? `${m.slice(0, 23)}…` : m;
      return [
        s('text', { x: L - 10, y: cy + 4, 'text-anchor': 'end' }, label),
        ...byModel[m].map((v) => s('circle', { class: 'dot', cx: x(v), cy, r: 4.5, fill: 'var(--sheet)', stroke: 'var(--ink)' })),
        s('line', { class: 'tick', x1: x(median(byModel[m])), x2: x(median(byModel[m])), y1: cy - 12, y2: cy + 12 })];
    }));

  return chartFrame(title, 'Each dot is one call to a ~450-token prompt; the bar is the median. Model time dominates, so this is not the gateway overhead.', svg);
}

function historyChart(history) {
  const pts = history.filter((r) => typeof r.fineness === 'number');
  if (pts.length < 2) return h('div');
  const H = 170, L = 44, R = 12, T = 12, B = 30;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + (1 - v / 1000) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Fineness over ${pts.length} runs, latest ${pts[pts.length - 1].fineness}.` },
    ...[0, 500, 1000].map((t) => [s('line', { class: 'grid', x1: L, x2: W - R, y1: y(t), y2: y(t) }), s('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end' }, String(t))]),
    s('path', { class: 'line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.fineness)}`).join('') }),
    ...pts.map((p, i) => s('circle', { class: 'dot', cx: x(i), cy: y(p.fineness), r: 4, fill: 'var(--sheet)', stroke: 'var(--ink)' })),
    s('text', { x: L, y: H - 8 }, new Date(pts[0].at).toLocaleDateString()),
    s('text', { x: W - R, y: H - 8, 'text-anchor': 'end' }, new Date(pts[pts.length - 1].at).toLocaleDateString()));
  return chartFrame('Fineness over time', 'One point per audit. `assay watch` adds a point on every interval.', svg);
}

/* ---------- estimator ---------- */

const EST_KEY = 'assay.estimator.v1';
const est = { rows: [], mode: 'fixed', discountPct: HEADLINE_DISCOUNT * 100, feePct: PLATFORM_FEE * 100 };

function loadEst() {
  try {
    const saved = JSON.parse(localStorage.getItem(EST_KEY) ?? 'null');
    if (saved && Array.isArray(saved.rows)) Object.assign(est, saved);
  } catch { /* private mode or corrupt: fall back to defaults */ }
}
function saveEst() {
  try { localStorage.setItem(EST_KEY, JSON.stringify(est)); } catch { /* ignore */ }
}

function defaultRows(catalog) {
  const audited = new Set(state.report?.models ?? []);
  const preferred = catalog.filter((m) => audited.has(m.id)).slice(0, 2);
  const picks = preferred.length >= 2 ? preferred : [...preferred, ...catalog.filter((m) => !audited.has(m.id))].slice(0, 2);
  return picks.map((m) => ({ id: m.id, input: 20, output: 4 }));
}

function renderEstimator() {
  const root = $('#estimator-root');
  clear(root);
  const catalog = state.catalog;
  if (!catalog.length) {
    root.append(h('p', { class: 'muted' }, 'No model catalog yet. Set ORBIO_API_KEY and run an audit (or start the server with a key) so Assay can read prices, or run '), h('code', { class: 'cmd' }, 'assay estimate --catalog prices.json'));
    return;
  }
  loadEst();
  const byId = new Map(catalog.map((m) => [m.id, m]));
  if (!est.rows.length) est.rows = defaultRows(catalog);

  const inputs = h('div', { class: 'est-inputs' });
  const result = h('div', { class: 'est-result', 'aria-live': 'polite' });

  const update = () => {
    saveEst();
    clear(result);
    result.append(...resultNodes(byId));
  };

  const drawInputs = () => {
    clear(inputs);
    const rows = h('div', { class: 'rows' },
      h('div', { class: 'row head', 'aria-hidden': 'true' }, h('span', {}, 'Model'), h('span', {}, 'Input Mtok/mo'), h('span', {}, 'Output Mtok/mo'), h('span')),
      est.rows.map((row, i) => h('div', { class: 'row' },
        h('label', { class: 'field model' }, h('span', { class: 'sr' }, `Model ${i + 1}`),
          h('input', { type: 'text', list: 'model-list', value: row.id, placeholder: 'provider/model', autocomplete: 'off', 'aria-invalid': !byId.has(row.id) && row.id !== '' ? 'true' : false,
            onInput: (e) => { row.id = e.target.value.trim(); e.target.setAttribute('aria-invalid', byId.has(row.id) || row.id === '' ? 'false' : 'true'); update(); } })),
        numberField(row.input, `Input million tokens per month, model ${i + 1}`, (v) => { row.input = v; update(); }),
        numberField(row.output, `Output million tokens per month, model ${i + 1}`, (v) => { row.output = v; update(); }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove model ${i + 1}`, onClick: () => { est.rows.splice(i, 1); drawInputs(); update(); } }, '×'))));

    inputs.append(
      h('datalist', { id: 'model-list' }, catalog.map((m) => h('option', { value: m.id }))),
      rows,
      h('div', {}, h('button', { class: 'btn quiet', type: 'button', onClick: () => { est.rows.push({ id: '', input: 10, output: 2 }); drawInputs(); update(); } }, 'Add model')),
      pricingMode(update, drawInputs));
  };

  drawInputs();
  update();
  root.append(h('div', { class: 'est' }, inputs, result));
}

function numberField(value, label, onChange) {
  return h('label', { class: 'field' }, h('span', { class: 'sr' }, label),
    h('input', { type: 'number', min: 0, step: 'any', value, inputmode: 'decimal', 'aria-label': label,
      onInput: (e) => onChange(Math.max(0, Number(e.target.value) || 0)) }));
}

function pricingMode(update, redraw) {
  const radio = (value, text) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'mode', value, checked: est.mode === value, onChange: () => { est.mode = value; redraw(); update(); } }), text);
  return h('fieldset', { class: 'mode' },
    h('legend', {}, 'How you buy credit'),
    radio('fixed', 'A fixed discount'),
    radio('book', `Fill from the liquidity book (snapshot ${BOOK_SNAPSHOT.takenAt})`),
    est.mode === 'fixed'
      ? h('div', { class: 'inline' },
          h('label', { class: 'field' }, 'Discount on credit, %', h('input', { type: 'number', min: 0, max: 95, step: 'any', value: est.discountPct, onInput: (e) => { est.discountPct = clamp(Number(e.target.value) || 0, 0, 95); update(); } })),
          h('label', { class: 'field' }, 'Platform fee, %', h('input', { type: 'number', min: 0, max: 50, step: 'any', value: est.feePct, onInput: (e) => { est.feePct = clamp(Number(e.target.value) || 0, 0, 50); update(); } })))
      : h('div', {},
          h('table', { class: 'book-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Discount'), h('th', {}, 'Credits available'))),
            h('tbody', {}, BOOK_SNAPSHOT.tiers.map((t) => h('tr', {}, h('td', {}, `${Math.round(t.discount * 100)}% off`), h('td', {}, fmtUsd(t.usd)))))),
          h('p', { class: 'muted small' }, 'Best tiers fill first, so a bigger monthly purchase earns a smaller blended discount. The live book differs; this is a dated snapshot.'),
          h('label', { class: 'field narrow' }, 'Platform fee, %', h('input', { type: 'number', min: 0, max: 50, step: 'any', value: est.feePct, onInput: (e) => { est.feePct = clamp(Number(e.target.value) || 0, 0, 50); update(); } }))));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function resultNodes(byId) {
  const fee = est.feePct / 100;
  const valid = est.rows.filter((r) => byId.has(r.id));
  const unknown = est.rows.filter((r) => r.id && !byId.has(r.id));
  const rows = valid.map((r) => ({ id: r.id, promptPrice: byId.get(r.id).promptPrice, completionPrice: byId.get(r.id).completionPrice, inputMtok: r.input, outputMtok: r.output }));
  const e = estimateWorkload(rows, { discount: est.discountPct / 100, fee, book: est.mode === 'book' ? BOOK_SNAPSHOT.tiers : null });

  if (!rows.length || e.usage <= 0) {
    return [h('p', { class: 'est-sub muted' }, 'Add a model and a monthly volume to see the cost.'), unknown.length ? h('ul', { class: 'notes' }, h('li', { class: 'warn' }, `Not in the catalog: ${unknown.map((u) => u.id).join(', ')}`)) : null];
  }

  const totalIn = valid.reduce((a, r) => a + r.input, 0);
  const totalOut = valid.reduce((a, r) => a + r.output, 0);
  const cheaper = e.saved > 0;
  const cmd = `assay estimate ./your-repo --input-mtok ${round(totalIn)} --output-mtok ${round(totalOut)}` + (est.mode === 'book' ? ' --book' : ` --discount ${round(est.discountPct)}`) + (est.feePct !== 5 ? ` --fee ${round(est.feePct)}` : '');

  return [
    h('p', { class: 'est-headline' }, cheaper ? 'You would pay ' : 'This would cost ', fmtUsd(e.cash), ' a month', cheaper && [' instead of ', h('span', { class: 'was' }, fmtUsd(e.usage))], '.'),
    h('p', { class: 'est-sub' }, cheaper
      ? `That keeps ${fmtUsd(e.saved)} a month, ${fmtUsd(e.annualSaved)} a year: ${fmtPct(e.savedPct)} after the ${round(est.feePct)}% fee, from a ${fmtPct(e.discount)} discount on credit.`
      : `Your ${fmtPct(e.discount)} discount does not cover the ${round(est.feePct)}% fee, so credit costs more than the usage it buys.`),
    h('table', { class: 'est-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Catalog price'), h('th', {}, 'With Orbio'))),
      h('tbody', {}, e.rows.map((r) => h('tr', {}, h('td', {}, r.id), h('td', {}, fmtUsd(r.usage)), h('td', {}, fmtUsd(r.cash)))))),
    h('ul', { class: 'notes' },
      h('li', {}, `Break-even: below a ${fmtPct(breakEvenDiscount(fee))} discount, credit costs more than the usage it buys.`),
      est.mode === 'book' && e.shortfall > 0 && h('li', { class: 'warn' }, `The snapshot book cannot fill ${fmtUsd(e.shortfall)} of this purchase; the discount shown covers only what it can.`),
      unknown.length > 0 && h('li', { class: 'warn' }, `Ignored, not in the catalog: ${unknown.map((u) => u.id).join(', ')}`),
      h('li', {}, 'Estimate, not a quote. The real discount is whatever the liquidity book offers when you buy.')),
    h('div', { class: 'cli' }, h('p', {}, 'Same estimate from your terminal, scanning a real repo for the models it uses:'), h('pre', { tabindex: 0 }, cmd)),
  ];
}

const round = (n) => Math.round(n * 100) / 100;

boot();
