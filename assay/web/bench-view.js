import { h, s, clear } from './dom.js';
import { cashCost, fmtPct, fmtUsd } from './pricing.js';
import { describe, recommend, statsFromReport } from './recommend.js';

/* The Bench page. It never runs the statistics: the report carries the intervals. What it does
   is re-apply the decision rule when the reader changes their margin, so the recommendation is
   visibly a function of how much quality loss they accept, not a fixed opinion. */

const BV_MARGINS = [2, 5, 10, 15];
const BV_VERDICT = {
  equivalent: ['pass', 'Equivalent'],
  worse: ['fail', 'Worse'],
  inconclusive: ['warn', 'Inconclusive'],
  insufficient: ['skip', 'Too few prompts'],
  unreliable: ['fail', 'Unreliable'],
  current: ['info', 'Current'],
};
const BV_GLYPH = {
  pass: () => [s('circle', { class: 'fill', cx: 12, cy: 12, r: 10 }), s('path', { class: 'mark', d: 'M7 12.5l3.2 3.2L17 8.8' })],
  warn: () => [s('path', { class: 'fill', d: 'M12 3L22 20H2z', 'stroke-linejoin': 'round' }), s('path', { class: 'mark', d: 'M12 9.5v4.5M12 17v.4' })],
  fail: () => [s('rect', { class: 'fill', x: 3, y: 3, width: 18, height: 18, rx: 3 }), s('path', { class: 'mark', d: 'M8.5 8.5l7 7M15.5 8.5l-7 7' })],
  skip: () => [s('circle', { class: 'fill', cx: 12, cy: 12, r: 10 }), s('path', { class: 'mark', d: 'M8 12h8' })],
  info: () => [s('path', { class: 'fill', d: 'M12 2L22 12L12 22L2 12z', 'stroke-linejoin': 'round' }), s('path', { class: 'mark', d: 'M12 11v5M12 8v.4' })],
};

const bvState = { margin: 5, benchId: null, calls: 100000, form: { dataset: '', current: '', candidates: 'auto', limit: '', maxSpend: '1' }, running: false };

const bvShort = (id) => id.split('/').pop();
const bvPts = (fraction) => `${fraction >= 0 ? '+' : '−'}${Math.abs(fraction * 100).toFixed(0)}`;

/**
 * @param {HTMLElement} root
 * @param {{state: any, refresh: () => Promise<void>, rerender: () => void, trackActivity?: () => Promise<void>, pricing: () => {discount:number, fee:number}, openInEstimator: (rows: any[]) => void}} api
 */
export function renderBenchView(root, api) {
  clear(root);
  const { state } = api;
  const bench = state.bench;
  if (bench && bvState.benchId !== bench.id) {
    bvState.benchId = bench.id;
    bvState.margin = bench.settings.marginPts;
  }
  if (!bvState.form.current && bench) bvState.form.current = bench.settings.current;

  root.append(bvTrust(state, bench));
  if (!bench) {
    root.append(bvEmpty(api));
    return;
  }

  const stats = statsFromReport(bench.models);
  const rec = recommend(stats, { marginPts: bvState.margin, minSamples: bench.settings.minSamples, minSavings: bench.settings.minSavings });
  const words = describe(rec, stats);

  root.append(
    h('div', { class: 'split top bench-top' }, bvHero(bench, rec, words, api), bvRunCard(api)),
    bvTable(bench, rec),
    bvEvidence(bench, stats, rec),
    bvSavings(bench, rec, api),
    bvFailures(bench));
}

/* ---------- trust: how far to believe this benchmark ---------- */

function bvTrust(state, bench) {
  const audit = bench?.trust?.audit ?? (state.report ? { fineness: state.report.score.fineness, grade: state.report.score.grade, at: state.report.finishedAt } : null);
  const billing = bench?.trust?.billing;
  const level = !audit ? 'info' : audit.fineness >= 950 ? 'pass' : audit.fineness >= 800 ? 'warn' : 'fail';
  const billed = billing && typeof billing.ratio === 'number' ? ` · this run billed ${billing.ratio.toFixed(3)}× catalog` : '';

  let message;
  if (!audit) message = ['This gateway has not been audited. ', h('a', { href: '#/audit' }, 'Run an audit'), ' so benchmarks carry a trust score.'];
  else if (level === 'pass') message = [h('b', {}, String(audit.fineness)), ` ${audit.grade} by Assay on ${new Date(audit.at).toLocaleDateString()}${billed} · `, h('a', { href: '#/audit' }, 'See the audit')];
  else message = [`Assay scored this gateway ${audit.fineness} (${audit.grade}). Read these results with caution · `, h('a', { href: '#/audit' }, 'See why')];

  return h('div', { class: 'trust', 'data-level': level },
    h('span', { class: 'trust-dot', 'data-status': level }, s('svg', { class: 'glyph', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ...BV_GLYPH[level]())),
    h('p', { class: 'trust-line' }, message));
}

/* ---------- empty state ---------- */

function bvEmpty(api) {
  return h('div', { class: 'split top empty' },
    h('div', {},
      h('h1', { id: 'bench-title', class: 'verdict' }, 'Which model should you ', h('span', { class: 'hl' }, 'actually use?')),
      h('p', { class: 'lede' }, 'Bench replays your own prompts against cheaper models through the same key, grades every answer, and says whether a switch is safe.'),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', {}, 'Capture. '), 'A file of your real prompts, each with a check that defines a correct answer.'),
        h('li', {}, h('strong', {}, 'Shadow-run. '), 'The same prompts go to several other models. Your live app is never touched.'),
        h('li', {}, h('strong', {}, 'Score. '), 'Hard checks where an answer is checkable; a judge with swapped order where it is not.'),
        h('li', {}, h('strong', {}, 'Report. '), 'Cost per correct answer, and a switch only if the evidence supports it.'))),
    bvRunCard(api));
}

/* ---------- verdict + margin control ---------- */

function bvHero(bench, rec, words, api) {
  const margin = h('fieldset', { class: 'seg' },
    h('legend', {}, 'Quality loss you would accept'),
    h('div', { class: 'seg-row' }, BV_MARGINS.map((m) => h('label', { class: 'seg-opt' },
      h('input', { type: 'radio', name: 'margin', id: `margin-${m}`, value: m, checked: bvState.margin === m,
        onChange: () => { bvState.margin = m; renderBenchView(document.getElementById('bench-root'), api); document.getElementById(`margin-${m}`)?.focus(); } }),
      h('span', {}, `${m}`, h('span', { 'aria-hidden': 'true' }, ' pts'), h('span', { class: 'sr' }, ' points'))))),
    h('p', { class: 'muted small' }, 'A cheaper model counts as equivalent only if even the pessimistic end of its 95% range stays inside this margin. Change it and the answer re-decides.'));

  const change = rec.action === 'switch' && h('div', { class: 'diff' },
    h('p', { class: 'diff-label' }, 'The one-line change'),
    h('pre', { tabindex: 0 }, h('span', { class: 'del' }, `- model: "${bench.settings.current}"\n`), h('span', { class: 'add' }, `+ model: "${rec.model}"`)));

  return h('div', { class: 'bench-hero', 'data-action': rec.action },
    h('h1', { id: 'bench-title', class: 'verdict' }, words.headline),
    h('p', { class: 'narrative' }, words.detail),
    margin, change);
}

function bvChip(kind) {
  const [status, word] = BV_VERDICT[kind] ?? ['skip', kind];
  return h('span', { class: 'status chip', 'data-status': status }, s('svg', { class: 'glyph', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ...BV_GLYPH[status]()), word);
}

function bvTable(bench, rec) {
  const costs = bench.models.map((m) => m.costPerCorrect1kUsd).filter((v) => typeof v === 'number' && v > 0);
  const lo = Math.log10(Math.min(...costs));
  const hi = Math.log10(Math.max(...costs));
  const bar = (v) => {
    const width = typeof v === 'number' && v > 0 && hi > lo ? 6 + ((Math.log10(v) - lo) / (hi - lo)) * 94 : 6;
    return s('svg', { class: 'minibar', viewBox: '0 0 100 8', 'aria-hidden': 'true' }, s('rect', { x: 0, y: 0, width, height: 8, rx: 4 }));
  };

  const rows = bench.models.map((m) => {
    const isCurrent = m.role === 'current';
    const verdict = isCurrent ? 'current' : rec.perModel[m.id].verdict;
    const needed = isCurrent ? null : rec.perModel[m.id].neededSamples;
    const q = m.qualityVsCurrent;
    const chosen = rec.action === 'switch' && rec.model === m.id;
    return h('tr', { class: chosen ? 'rec' : isCurrent ? 'cur' : false },
      h('th', { scope: 'row' }, bvShort(m.id), h('small', {}, `${m.id.split('/')[0]}${m.latencyP50Ms ? ` · ${m.latencyP50Ms} ms` : ''}`)),
      h('td', {}, fmtUsd(m.costPer1kUsd), !isCurrent && m.savings > 0 && h('small', {}, `${fmtPct(m.savings)} cheaper`)),
      h('td', {}, isCurrent ? '100%' : q ? `${(q.est * 100).toFixed(0)}% ±${(((q.hi - q.lo) / 2) * 100).toFixed(0)}` : '—',
        h('small', {}, `${(m.accuracy * 100).toFixed(0)}% correct (${m.correct}/${m.n})`)),
      h('td', {}, typeof m.costPerCorrect1kUsd === 'number' ? fmtUsd(m.costPerCorrect1kUsd) : '—', bar(m.costPerCorrect1kUsd)),
      h('td', {}, bvChip(verdict), needed && h('small', {}, `about ${needed} prompts would settle it`), m.errorRate > 0 && h('small', {}, `${(m.errorRate * 100).toFixed(0)}% of calls failed`), m.cutOff > 0 && h('small', {}, `${m.cutOff} empty or cut off`)));
  });

  const spent = Number(bench.spend.actualUsd ?? bench.spend.expectedUsd);
  return h('div', { class: 'card results' },
    h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Benchmark results, scrolls sideways on small screens' },
      h('table', { class: 'bench-table' },
        h('caption', { class: 'sr' }, 'Cost, quality and verdict for each model'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Model'), h('th', { scope: 'col' }, 'Cost / 1k calls'), h('th', { scope: 'col' }, 'Quality vs. current'),
          h('th', { scope: 'col' }, 'Cost per correct answer'), h('th', { scope: 'col' }, 'Verdict'))),
        h('tbody', {}, rows))),
    h('p', { class: 'results-foot' }, `Cost per correct answer is cost per 1k calls divided by accuracy. ± is a 95% range. ${bench.dataset.prompts} prompts from “${bench.dataset.name}” (${bench.dataset.judged} judged), ${fmtUsd(spent)} spent, ${new Date(bench.finishedAt).toLocaleString()}.`));
}

/* ---------- evidence charts ---------- */

const BV_W = 520;

/** Is it as good? Each bar is the 95% range of (candidate − current); the margin line is the bar to clear. */
function bvIntervalChart(stats, rec) {
  const cands = stats.filter((m) => !m.isCurrent && m.diff);
  if (!cands.length) return null;
  const margin = bvState.margin / 100;
  const xmin = Math.floor(Math.min(-margin - 0.05, ...cands.map((c) => c.diff.lo)) * 10) / 10;
  const xmax = Math.ceil(Math.max(0.1, ...cands.map((c) => c.diff.hi)) * 10) / 10;
  const L = 150, R = 96, T = 30, B = 40, rowH = 46;
  const H = T + cands.length * rowH + B;
  const x = (v) => L + ((v - xmin) / (xmax - xmin)) * (BV_W - L - R);
  const ticks = [];
  for (let t = Math.ceil(xmin * 10) / 10; t <= xmax + 1e-9; t += 0.1) ticks.push(Math.round(t * 10) / 10);

  const svg = s('svg', { viewBox: `0 0 ${BV_W} ${H}`, role: 'img',
    'aria-label': `Accuracy difference against the current model, with a 95% range per candidate. Recommendation needs the range to stay right of minus ${bvState.margin} points. ${cands.map((c) => `${bvShort(c.id)}: ${bvPts(c.diff.est)} points, range ${bvPts(c.diff.lo)} to ${bvPts(c.diff.hi)}`).join('; ')}.` },
    s('rect', { class: 'band', x: x(-margin), y: T - 10, width: x(xmax) - x(-margin), height: cands.length * rowH + 14 }),
    s('line', { class: 'axis', x1: x(0), x2: x(0), y1: T - 10, y2: T + cands.length * rowH + 4 }),
    s('line', { class: 'margin-line', x1: x(-margin), x2: x(-margin), y1: T - 10, y2: T + cands.length * rowH + 4 }),
    s('text', { x: x(-margin), y: T - 16, 'text-anchor': 'middle' }, `−${bvState.margin} pts: your margin`),
    ...ticks.map((t) => s('text', { x: x(t), y: H - 20, 'text-anchor': 'middle' }, t === 0 ? '0' : bvPts(t))),
    s('text', { x: (x(xmin) + x(xmax)) / 2, y: H - 4, 'text-anchor': 'middle' }, 'accuracy points versus the current model'),
    ...cands.map((c, i) => {
      const cy = T + i * rowH + rowH / 2;
      const verdict = rec.perModel[c.id]?.verdict ?? 'insufficient';
      return [
        s('text', { x: L - 10, y: cy + 4, 'text-anchor': 'end' }, bvShort(c.id).length > 22 ? `${bvShort(c.id).slice(0, 21)}…` : bvShort(c.id)),
        s('line', { class: 'whisker', x1: x(c.diff.lo), x2: x(c.diff.hi), y1: cy, y2: cy }),
        s('line', { class: 'whisker-cap', x1: x(c.diff.lo), x2: x(c.diff.lo), y1: cy - 7, y2: cy + 7 }),
        s('line', { class: 'whisker-cap', x1: x(c.diff.hi), x2: x(c.diff.hi), y1: cy - 7, y2: cy + 7 }),
        s('circle', { class: 'dot', cx: x(c.diff.est), cy, r: 5, fill: 'var(--sheet)', stroke: 'var(--ink)' }),
        s('text', { x: BV_W - R + 8, y: cy + 4 }, (BV_VERDICT[verdict] ?? ['', verdict])[1]),
      ];
    }));
  return bvChartFrame('Is it as good?', 'Each bar is the 95% range for how much better or worse the model is than your current one. To recommend a switch, the whole bar must sit inside the shaded area.', svg);
}

/** Cost per 1,000 correct answers on a log axis: the prices differ by orders of magnitude. */
function bvCostChart(stats) {
  const rows = stats.filter((m) => typeof m.costPerCorrect === 'number' && m.costPerCorrect > 0);
  if (rows.length < 2) return null;
  const logs = rows.map((m) => Math.log10(m.costPerCorrect));
  const dmin = Math.floor(Math.min(...logs) - 0.2);
  const dmax = Math.ceil(Math.max(...logs) + 0.2);
  const L = 150, R = 80, T = 14, B = 34, rowH = 40;
  const H = T + rows.length * rowH + B;
  const x = (v) => L + ((Math.log10(v) - dmin) / (dmax - dmin)) * (BV_W - L - R);
  const decades = [];
  for (let d = dmin; d <= dmax; d++) decades.push(d);

  const svg = s('svg', { viewBox: `0 0 ${BV_W} ${H}`, role: 'img',
    'aria-label': `Cost per 1,000 correct answers on a logarithmic scale: ${rows.map((m) => `${bvShort(m.id)} ${fmtUsd(m.costPerCorrect)}`).join('; ')}.` },
    ...decades.map((d) => [
      s('line', { class: 'grid', x1: L + ((d - dmin) / (dmax - dmin)) * (BV_W - L - R), x2: L + ((d - dmin) / (dmax - dmin)) * (BV_W - L - R), y1: T, y2: H - B }),
      s('text', { x: L + ((d - dmin) / (dmax - dmin)) * (BV_W - L - R), y: H - 16, 'text-anchor': 'middle' }, fmtUsd(10 ** d)),
    ]),
    s('line', { class: 'axis', x1: L, x2: BV_W - R, y1: H - B, y2: H - B }),
    ...rows.map((m, i) => {
      const cy = T + i * rowH + rowH / 2;
      return [
        s('text', { x: L - 10, y: cy + 4, 'text-anchor': 'end', class: m.isCurrent ? 'strong' : false }, bvShort(m.id).length > 22 ? `${bvShort(m.id).slice(0, 21)}…` : bvShort(m.id)),
        s('line', { class: 'stem', x1: L, x2: x(m.costPerCorrect), y1: cy, y2: cy }),
        s('circle', { class: 'dot', cx: x(m.costPerCorrect), cy, r: m.isCurrent ? 7 : 5, fill: m.isCurrent ? 'var(--ink)' : 'var(--sheet)', stroke: 'var(--ink)' }),
        s('text', { x: x(m.costPerCorrect) + 12, y: cy + 4 }, fmtUsd(m.costPerCorrect)),
      ];
    }),
    s('text', { x: (L + BV_W - R) / 2, y: H - 2, 'text-anchor': 'middle' }, 'cost per 1,000 correct answers (log scale)'));
  return bvChartFrame('What a right answer costs', 'The cheapest model is not the best value if it is often wrong. Dividing cost by accuracy puts every model on one scale.', svg);
}

function bvChartFrame(title, blurb, svg) {
  return h('figure', { class: 'chart' }, h('h3', {}, title), h('p', {}, blurb), svg);
}

function bvEvidence(bench, stats, rec) {
  const charts = [bvIntervalChart(stats, rec), bvCostChart(stats)].filter(Boolean);
  if (!charts.length) return h('div');
  return h('div', {},
    h('div', { class: 'section-head' }, h('h2', {}, 'The evidence'), h('p', {}, 'Why the recommendation says what it says.')),
    h('div', { class: 'evidence-grid bench-evidence' }, charts));
}

/* ---------- savings at your volume ---------- */

function bvSavings(bench, rec, api) {
  if (rec.action === 'keep') return h('div');
  const cur = bench.models.find((m) => m.role === 'current');
  const tgt = bench.models.find((m) => m.id === rec.model);
  if (!cur || !tgt) return h('div');
  const { discount, fee } = api.pricing();
  const hypothetical = rec.action !== 'switch';

  const out = h('div', { class: 'savings-out', 'aria-live': 'polite' });
  const draw = () => {
    clear(out);
    const perMonth = (m) => (m.costPer1kUsd * bvState.calls) / 1000;
    const c = perMonth(cur);
    const t = perMonth(tgt);
    // Element.append() would print a literal "false", so filter before appending.
    out.append(...[
      h('p', { class: 'est-headline' }, `${fmtUsd(c)} → ${fmtUsd(t)}`),
      h('p', { class: 'est-sub' }, `a month at catalog price, for ${bvState.calls.toLocaleString()} calls. With Orbio credit (${fmtPct(discount)} off, ${fmtPct(fee)} fee): ${fmtUsd(cashCost(c, discount, fee))} → ${fmtUsd(cashCost(t, discount, fee))}.`),
      hypothetical && h('p', { class: 'muted small' }, 'Projected only: the switch is not proven yet.'),
    ].filter(Boolean));
  };
  draw();

  return h('div', { class: 'card bench-savings' },
    h('div', { class: 'split' },
      h('div', {},
        h('h3', {}, 'What that saves you'),
        h('label', { class: 'field narrow calls' }, 'Calls per month',
          h('input', { type: 'number', min: 1, step: 'any', value: bvState.calls, onInput: (e) => { bvState.calls = Math.max(1, Number(e.target.value) || 1); draw(); } })),
        h('button', { class: 'btn quiet small', type: 'button', onClick: () => {
          const m = bvState.calls / 1e6;
          api.openInEstimator([{ id: tgt.id, input: Math.round((tgt.avgPromptTokens ?? 0) * m * 100) / 100, output: Math.round((tgt.avgCompletionTokens ?? 0) * m * 100) / 100 }]);
        } }, 'Price the switch in the estimator')),
      out));
}

/* ---------- where the cheaper models went wrong ---------- */

function bvFailures(bench) {
  const cands = bench.models.filter((m) => m.role === 'candidate' && (m.failures?.length || m.judge));
  if (!cands.length) return h('div');
  return h('div', {},
    h('div', { class: 'section-head' }, h('h2', {}, 'Where the cheaper models went wrong'), h('p', {}, 'A few misses per model. Numbers hide the difference between a typo and a disaster.')),
    h('div', { class: 'card bench-failures' }, cands.map((m) => h('details', { class: 'fail-model' },
      h('summary', {}, h('span', { class: 'fail-name' }, bvShort(m.id)), h('span', { class: 'fail-count' }, `${m.n - m.correct} of ${m.n} wrong`)),
      h('div', { class: 'fail-body' },
        m.judge && h('p', { class: 'muted small' }, `Fuzzy answers judged by ${m.judge.model}: ${m.judge.pairs} comparisons, order-swapped. The judge changed its pick when the order flipped ${m.judge.positionBiased} time${m.judge.positionBiased === 1 ? '' : 's'}${m.judge.invalid ? `, and ${m.judge.invalid} verdict${m.judge.invalid === 1 ? '' : 's'} could not be parsed` : ''}.`),
        (m.failures ?? []).map((f) => h('div', { class: 'fail-row' },
          h('p', { class: 'fail-prompt' }, f.prompt),
          h('p', {}, 'Answered: ', h('code', {}, f.answer || '(nothing)')),
          h('p', { class: 'muted small' }, f.reason))),
        !(m.failures ?? []).length && h('p', { class: 'muted small' }, 'No excerpts were kept for this run.'))))));
}

/* ---------- run card: the action, like a checkout ---------- */

function bvRunCard(api) {
  const { state } = api;
  if (!state.canBench || state.static) {
    return h('div', { class: 'card run-card' },
      h('p', { class: 'card-title' }, 'Run it from your terminal'),
      h('div', { class: 'cli-block' },
        h('pre', { tabindex: 0 }, 'assay bench --sample \\\n  --current openai/gpt-6-astra'),
        h('p', { class: 'card-note' }, 'Uses your own prompts instead with --data prompts.jsonl. Add --dry-run first to see the plan and the cost.')));
  }

  const status = h('p', { id: 'bench-status', class: 'status-line' }, '');
  const progress = h('progress', { id: 'bench-progress', max: 1, value: 0, hidden: true, 'aria-label': 'Benchmark progress' });
  const f = bvState.form;
  const input = (key, props) => h('input', { ...props, value: f[key], onInput: (e) => { f[key] = e.target.value; } });
  const button = h('button', { class: 'btn wide', type: 'button' }, 'Run benchmark');

  const run = async () => {
    button.disabled = true;
    progress.hidden = false;
    status.classList.remove('error');
    status.textContent = 'Starting…';
    try {
      const body = {
        dataset: f.dataset || state.datasets[0]?.id || 'sample', current: f.current.trim(),
        candidates: !f.candidates.trim() || f.candidates.trim() === 'auto' ? 'auto' : f.candidates.split(',').map((x) => x.trim()).filter(Boolean),
        limit: f.limit === '' ? undefined : Number(f.limit), maxSpend: Number(f.maxSpend) || 1,
      };
      const res = await fetch('/api/bench/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) throw new Error(reply.error ?? `HTTP ${res.status}`);
      api.trackActivity?.();
      for (;;) {
        const st = await (await fetch('/api/bench/status')).json();
        status.textContent = st.error ? `Benchmark failed: ${st.error}` : st.message;
        if (st.total) { progress.max = st.total; progress.value = st.done; }
        if (!st.running) {
          if (st.error) throw new Error(st.error);
          break;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      await api.refresh();
      api.rerender();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('error');
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener('click', run);

  return h('div', { class: 'card run-card' },
    h('p', { class: 'card-title' }, 'Run a benchmark'),
    h('div', { class: 'run-fields' },
      h('label', { class: 'field' }, 'Prompts',
        h('select', { onChange: (e) => { f.dataset = e.target.value; } }, state.datasets.map((d) => h('option', { value: d.id, selected: f.dataset === d.id }, `${d.label} (${d.prompts})`)))),
      h('label', { class: 'field' }, 'The model you use today',
        input('current', { type: 'text', list: 'bench-models', placeholder: 'provider/model', autocomplete: 'off' }))),
    h('details', {},
      h('summary', {}, 'Options'),
      h('div', { class: 'run-grid' },
        h('label', { class: 'field wide' }, 'Cheaper models to try',
          input('candidates', { type: 'text', placeholder: 'auto, or provider/model, provider/model' })),
        h('label', { class: 'field' }, 'Score at most',
          input('limit', { type: 'number', min: 5, max: 1000, placeholder: 'all' })),
        h('label', { class: 'field' }, 'Spend cap, $',
          input('maxSpend', { type: 'number', min: 0.01, max: 5, step: 'any' })))),
    h('div', { class: 'run-fields' }, button),
    progress, status,
    h('datalist', { id: 'bench-models' }, state.catalog.map((m) => h('option', { value: m.id }))),
    h('p', { class: 'card-note' }, 'Uses your key. Your live app is not touched. A hard spend cap keeps it cheap.'));
}
