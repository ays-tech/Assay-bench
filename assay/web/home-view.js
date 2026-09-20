import { h, clear } from './dom.js';
import { fmtUsd } from './pricing.js';

/* The overview: what this is, why it exists, and where to go next. It shows real numbers when the
   reader has run an audit or a benchmark, and clearly labelled examples when they have not. */

const HOME_EXAMPLE = [
  { name: 'Current (big model)', current: true, cost: '$8.00', quality: '100%', cpc: '$8.00' },
  { name: 'Model B', win: true, cost: '$0.90', quality: '96% ±3%', cpc: '$0.94' },
  { name: 'Model C', cost: '$0.30', quality: '71%', cpc: '$0.42' },
];

const HOME_WHY = [
  ['A discount only matters if the gateway is honest',
    'Cheap inference means little if it bills more than it lists, or quietly serves a smaller model than the one you asked for. Assay checks both with your own key, for a few cents.'],
  ['The cheapest model is not the cheapest answer',
    'A model that costs 90% less but is wrong one time in three can cost more per correct answer than it saves. Bench measures that on your own prompts, not on a leaderboard.'],
  ['A switch should need proof',
    'Bench recommends a cheaper model only when even the pessimistic end of a 95% range clears the quality loss you accept. Otherwise it tells you how many more prompts would settle it.'],
];

/**
 * @param {HTMLElement} root
 * @param {{state: any}} api
 */
export function renderHome(root, { state }) {
  clear(root);
  root.append(homeHero(state), homeWhy(), homeHow());
}

function homeRows(bench) {
  if (!bench) return { rows: HOME_EXAMPLE, example: true };
  // Current model first, then candidates from best quality down: the question is how much quality a saving costs.
  const models = [...bench.models].sort((a, b) => (a.role === 'current' ? -1 : b.role === 'current' ? 1 : (b.qualityVsCurrent?.est ?? 0) - (a.qualityVsCurrent?.est ?? 0)));
  const winner = bench.recommendation.action === 'switch' ? bench.recommendation.model : null;
  const rows = models.slice(0, 4).map((m) => ({
    name: m.id.split('/').pop(),
    current: m.role === 'current',
    win: m.id === winner,
    cost: fmtUsd(m.costPer1kUsd),
    quality: m.role === 'current' ? '100%' : m.qualityVsCurrent ? `${(m.qualityVsCurrent.est * 100).toFixed(0)}% ±${(((m.qualityVsCurrent.hi - m.qualityVsCurrent.lo) / 2) * 100).toFixed(0)}` : '—',
    cpc: typeof m.costPerCorrect1kUsd === 'number' ? fmtUsd(m.costPerCorrect1kUsd) : '—',
  }));
  return { rows, example: false };
}

function homeHero(state) {
  const { bench, report } = state;
  const { rows, example } = homeRows(bench);

  const table = h('table', { class: 'mini' },
    h('caption', { class: 'sr' }, 'Cost and quality of each model against your current one'),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Model'), h('th', { scope: 'col' }, 'Cost / 1k calls'),
      h('th', { scope: 'col' }, 'Quality vs. current'), h('th', { scope: 'col' }, 'Cost per correct answer'))),
    h('tbody', {}, rows.map((r) => h('tr', { class: r.win ? 'win' : false },
      h('th', { scope: 'row' }, r.name, r.current && h('span', { class: 'tag' }, 'current'), r.win && h('span', { class: 'tag' }, 'switch')),
      h('td', {}, r.cost), h('td', {}, r.quality), h('td', {}, r.cpc)))));

  const card = h('div', { class: 'card' },
    h('p', { class: 'card-title' }, example ? 'What Bench tells you' : 'Your latest benchmark'),
    table,
    h('p', { class: 'card-note' }, example
      ? 'Illustrative numbers. Run a benchmark on your own prompts to see yours.'
      : `${bench.dataset.prompts} of your prompts, on ${bench.gateway.host}. `,
    !example && h('a', { href: '#/bench' }, 'Open the full result')));

  const stats = [];
  if (report && report.score.fineness !== null) {
    stats.push(h('div', { class: 'stat' }, h('b', {}, String(report.score.fineness), h('small', {}, '/ 1000')), h('span', {}, `gateway fineness, ${report.score.grade.toLowerCase()}`)));
  }
  if (bench?.recommendation.action === 'switch') {
    stats.push(h('div', { class: 'stat' }, h('b', {}, `${Math.round(bench.recommendation.savings * 100)}%`), h('span', {}, 'cheaper at equivalent quality')));
  } else if (bench) {
    stats.push(h('div', { class: 'stat' }, h('b', {}, fmtUsd(Number(bench.spend.actualUsd ?? bench.spend.expectedUsd))), h('span', {}, `to benchmark ${bench.models.length} models`)));
  }

  return h('section', { class: 'wrap home-hero' },
    h('div', { class: 'split' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'For Orbio users'),
        h('h1', { id: 'home-title' }, 'Verify the gateway.', h('br'), 'Then ', h('span', { class: 'hl' }, 'pick the model.')),
        h('p', { class: 'lede' }, 'Assay proves your inference gateway bills what it lists and serves the model you asked for. Bench then finds the cheapest model that is still good enough for your prompts.'),
        h('div', { class: 'cta' },
          h('a', { class: 'btn', href: '#/audit' }, 'Run an audit'),
          h('a', { class: 'btn quiet', href: '#/bench' }, 'See the benchmark'))),
      card),
    stats.length > 0 && h('div', { class: 'stat-row' }, stats));
}

function homeWhy() {
  return h('section', { class: 'wrap', 'aria-label': 'Why Assay exists' },
    h('div', { class: 'why' }, HOME_WHY.map(([title, body]) => h('article', {}, h('h3', {}, title), h('p', {}, body)))));
}

function homeHow() {
  return h('section', { class: 'wrap how', 'aria-labelledby': 'how-title' },
    h('h2', { id: 'how-title' }, 'Two questions, in order.'),
    h('div', { class: 'how-grid' },
      h('div', { class: 'card how-card' },
        h('span', { class: 'n' }, '01'),
        h('h3', {}, 'Can I trust the gateway?'),
        h('p', {}, 'Assay spends a few cents on fixed prompts and compares what the gateway says with what your balance does: billing, model identity, token counts, API behaviour.'),
        h('a', { class: 'btn', href: '#/audit' }, 'Open the audit')),
      h('div', { class: 'card how-card' },
        h('span', { class: 'n' }, '02'),
        h('h3', {}, 'Which model should I use?'),
        h('p', {}, 'Bench replays your own prompts on cheaper models, grades every answer, and recommends a switch only when the evidence supports it.'),
        h('a', { class: 'btn', href: '#/bench' }, 'Open Bench'))),
    h('p', { class: 'limits' }, 'Assay cannot see whether prompts are stored, and a benchmark is only as representative as the prompts you give it. ', h('a', { href: '#/method' }, 'What it can and cannot prove')));
}
