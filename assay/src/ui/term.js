import { fmtPct, fmtUsd } from '../../web/pricing.js';

const ANSI = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, gray: 90 };

/**
 * Colour helpers that turn themselves off when output is not a TTY or NO_COLOR is set.
 * @param {{isTTY?: boolean, columns?: number}} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function makeTerm(stream = process.stdout, env = process.env) {
  const enabled = Boolean(stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
  const paint = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  const c = Object.fromEntries(Object.entries(ANSI).map(([name, code]) => [name, paint(code)]));
  return { c, enabled, columns: Math.min(Math.max(stream.columns ?? 100, 60), 120) };
}

const GLYPH = { pass: '✔', warn: '▲', fail: '✖', skip: '–', info: '·' };
const WORD = { pass: 'verified', warn: 'review', fail: 'FAILED', skip: 'not run', info: 'measured' };
const COLOR = { pass: 'green', warn: 'yellow', fail: 'red', skip: 'gray', info: 'blue' };

/** Word-wrap to `width`, indenting continuation lines. @param {string} text */
export function wrap(text, width, indent = '') {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? indent + l : l)).join('\n');
}

/**
 * @param {any} report
 * @param {ReturnType<typeof makeTerm>} t
 * @param {{savedPath?: string}} [opts]
 */
export function renderReport(report, t, { savedPath, dir = '.assay' } = {}) {
  const { c } = t;
  const { score } = report;
  const out = [];
  const num = score.fineness === null ? '—' : String(score.fineness);

  out.push('', `  ${c.bold('ASSAY')}  ${c.dim(`audit of ${report.gateway.host}`)}`, '');
  const w = 22;
  const pad = (s) => ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;
  out.push(`   ${c.dim('┌' + '─'.repeat(w) + '┐')}`);
  out.push(`   ${c.dim('│')}${c.bold(pad(num).padEnd(w))}${c.dim('│')}   ${c.bold(score.grade)}${score.capped ? c.red('  (capped: an integrity check failed)') : ''}`);
  out.push(`   ${c.dim('│')}${c.dim(pad('parts per thousand').padEnd(w))}${c.dim('│')}   ${wrap(report.headline, t.columns - 30, '                              ')}`);
  out.push(`   ${c.dim('└' + '─'.repeat(w) + '┘')}   ${c.dim(`coverage ${Math.round(score.coverage * 100)}% of check weight`)}`);
  out.push('');

  for (const check of report.checks) {
    const head = `  ${c[COLOR[check.status]](`${GLYPH[check.status]} ${WORD[check.status].padEnd(8)}`)}  ${c.bold(check.id.padEnd(9))}`;
    out.push(`${head} ${wrap(check.summary, t.columns - 26, ' '.repeat(24))}`);
  }

  const spent = report.spend.actualUsd ?? report.spend.expectedUsd;
  out.push('', c.dim(`  ${report.spend.calls} calls · $${Number(spent).toFixed(4)} spent of a $${Number(report.spend.capUsd).toFixed(2)} cap · ${(report.durationMs / 1000).toFixed(1)}s`));
  if (report.narrative) out.push('', `  ${wrap(report.narrative.text, t.columns - 4, '  ')}`, c.dim(`  (written by ${report.narrative.model}; every number verified against the results)`));
  if (savedPath) {
    const flag = dir === '.assay' ? '' : ` --dir ${dir}`;
    out.push(c.dim(`  saved ${savedPath}`), c.dim(`  open it:  assay serve${flag}   ·   share it:  assay export${flag}`));
  }
  out.push('');
  return out.join('\n');
}

/**
 * @param {ReturnType<import('../estimate/index.js').estimateRepo>} r
 * @param {ReturnType<typeof makeTerm>} t
 * @param {string} orbioBase
 */
export function renderEstimate(r, t, orbioBase) {
  const { c } = t;
  const out = ['', `  ${c.bold('ASSAY ESTIMATE')}  ${c.dim(`${r.path} · ${r.filesScanned} files scanned`)}`, ''];

  if (r.endpoints.length) {
    out.push(`  ${c.bold('Where this code talks to a provider')}`);
    for (const e of r.endpoints) {
      out.push(`    ${e.file}:${e.line}  ${e.match}`, `      ${c.green('→')} ${orbioBase}   ${c.dim(e.note)}`);
    }
    if (r.envVars.length) out.push(`    ${c.dim('Keys read from:')} ${[...new Set(r.envVars.map((v) => v.name))].join(', ')}`);
    out.push('');
  }

  if (!r.models.length) {
    out.push('  No model ids found in the code. Pass a volume and a model list to the dashboard estimator instead.', '');
  } else {
    out.push(`  ${c.bold('Models in use')}`);
    for (const m of r.models) {
      out.push(`    ${m.id.padEnd(34)} ${String(m.refs).padStart(3)} refs   ${fmtUsd(m.promptPrice * 1e6)} in / ${fmtUsd(m.completionPrice * 1e6)} out per 1M tokens`);
    }
    if (r.unmatched.length) out.push(`    ${c.yellow('Not in the catalog:')} ${r.unmatched.map((u) => `${u.raw} (${u.refs})`).join(', ')}`);
    out.push('');
  }

  const a = r.assumptions;
  if (r.estimate) {
    const e = r.estimate;
    out.push(`  ${c.bold('Estimated per month')}`);
    out.push(`    at catalog price   ${fmtUsd(e.usage).padStart(12)}`);
    out.push(`    with Orbio         ${c.bold(fmtUsd(e.cash).padStart(12))}   ${c.dim(`${fmtPct(e.discount)} discount on credit, ${fmtPct(a.fee)} platform fee`)}`);
    out.push(e.saved > 0
      ? `    you keep           ${c.green(fmtUsd(e.saved).padStart(12))}   ${fmtPct(e.savedPct)} · ${fmtUsd(e.annualSaved)} a year`
      : `    ${c.red('this costs more than paying catalog price: the discount does not cover the fee')}`);
    if (e.shortfall > 0) out.push(`    ${c.yellow(`the snapshot book cannot fill ${fmtUsd(e.shortfall)} of this purchase`)}`);
    out.push('', c.dim(`  Assumptions: volume split by code references; ${a.book ? `discount blended from the liquidity book (snapshot ${a.bookSnapshot})` : `fixed ${fmtPct(a.discount)} discount`}. An estimate, not a quote.`));
  } else {
    out.push(c.dim('  Add --input-mtok and --output-mtok (millions of tokens per month) to price this workload.'));
  }
  out.push('');
  return out.join('\n');
}

const usd = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/**
 * @param {any} report an assay.bench/1 report
 * @param {ReturnType<typeof makeTerm>} t
 * @param {{savedPath?: string, dir?: string}} [opts]
 */
export function renderBench(report, t, { savedPath, dir = '.assay' } = {}) {
  const { c } = t;
  const rec = report.recommendation;
  const audit = report.trust.audit;
  const out = ['', `  ${c.bold('ASSAY BENCH')}  ${c.dim(`${report.dataset.name} · ${report.dataset.prompts} prompts · ${report.gateway.host}`)}`, ''];

  const color = rec.action === 'switch' ? c.green : rec.action === 'keep' ? c.yellow : c.blue;
  out.push(`  ${color(c.bold(rec.headline))}`, `  ${wrap(rec.detail, t.columns - 4, '  ')}`, '');

  const short = (id) => (id.length > 30 ? `…${id.slice(-29)}` : id);
  const head = ['model', 'cost / 1k calls', 'quality vs current', 'cost / 1k correct', 'p50', 'verdict'];
  const rows = report.models.map((m) => {
    const q = m.qualityVsCurrent;
    const quality = m.role === 'current' ? '100%' : q ? `${(q.est * 100).toFixed(0)}% ±${(((q.hi - q.lo) / 2) * 100).toFixed(0)}` : '—';
    const mark = m.id === rec.model && rec.action !== 'keep' ? '►' : m.role === 'current' ? '●' : ' ';
    return [`${mark} ${short(m.id)}`, usd(m.costPer1kUsd), quality, usd(m.costPerCorrect1kUsd), m.latencyP50Ms ? `${m.latencyP50Ms}ms` : '—', m.role === 'current' ? 'current' : m.verdict];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => `  ${cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('   ')}`;
  out.push(c.dim(line(head)));
  report.models.forEach((m, i) => {
    const text = line(rows[i]);
    out.push(m.id === rec.model && rec.action === 'switch' ? c.green(text) : m.verdict === 'worse' || m.verdict === 'unreliable' ? c.dim(text) : text);
  });

  if (rec.configChange) out.push('', c.dim('  Change:'), c.red(`  - model: "${rec.configChange.from}"`), c.green(`  + model: "${rec.configChange.to}"`));
  if (rec.action === 'need-more-data') out.push('', c.dim(`  Or accept a wider quality margin:  assay bench … --margin ${rec.marginPts * 2}`));

  out.push('');
  const b = report.trust.billing;
  out.push(c.dim(`  Billing on this run: ${b.calls} calls, billed ${b.ratio === null ? 'n/a' : `${b.ratio.toFixed(3)}×`} the catalog price (${b.verdict === 'ok' ? 'reconciled' : b.verdict}).`));
  out.push(c.dim(audit ? `  Gateway audit: fineness ${audit.fineness} (${audit.grade}) on ${new Date(audit.at).toLocaleDateString()}.` : '  Gateway audit: none yet. Run `assay run` so benchmarks carry a trust score.'));
  for (const note of report.notes) out.push(c.yellow(`  note: ${wrap(note, t.columns - 10, '        ')}`));
  for (const s of report.skipped) out.push(c.dim(`  skipped ${s.id}: ${s.error}`));
  const spent = report.spend.actualUsd ?? report.spend.expectedUsd;
  out.push(c.dim(`  ${report.spend.calls} calls · $${Number(spent).toFixed(4)} spent (${usd(Number(report.spend.judgeUsd))} of it judging) · ${(report.durationMs / 1000).toFixed(1)}s`));
  if (savedPath) {
    const flag = dir === '.assay' ? '' : ` --dir ${dir}`;
    out.push(c.dim(`  saved ${savedPath}`), c.dim(`  open it:  assay serve${flag}  (Bench tab)`));
  }
  out.push('');
  return out.join('\n');
}

/** @param {any} plan */
export function renderBenchPlan(plan, t) {
  const { c } = t;
  const out = ['', `  ${c.bold('ASSAY BENCH')}  ${c.dim('plan (dry run: only tiny preflight calls were made)')}`, ''];
  out.push(`  current      ${plan.current}`, `  candidates   ${plan.candidates.join(', ')}`);
  const judges = Object.entries(plan.judges);
  if (judges.length) out.push(`  judges       ${judges.map(([cand, j]) => `${j} for ${cand.split('/').pop()}`).join('; ')}`);
  out.push(`  prompts      ${plan.prompts} (${plan.judgedPrompts} need a judge)`, `  calls        about ${plan.estimate.calls}`, `  est. cost    ${usd(plan.estimate.usd)} of a ${usd(plan.capUsd)} cap`);
  for (const s of plan.skipped) out.push(c.dim(`  skipped ${s.id}: ${s.error}`));
  out.push('', c.dim('  Drop --dry-run to run it.'), '');
  return out.join('\n');
}
