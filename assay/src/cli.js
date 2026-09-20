import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAudit } from './agent.js';
import { normalizeCatalog, selectAuditModels } from './catalog.js';
import { OrbioClient } from './client.js';
import { ConfigError, DEFAULT_BASE_URL, VERSION, loadDotenv, parseDuration, resolveConfig } from './config.js';
import { buildStaticHtml } from './export.js';
import { estimateRepo, migrationHints, toPriced } from './estimate/index.js';
import { createMockGateway, MOCK_KEY } from './mock/gateway.js';
import { clip, redact } from './redact.js';
import { createDashboardServer } from './server.js';
import { createStore } from './store.js';
import { makeTerm, renderBench, renderBenchPlan, renderEstimate, renderReport } from './ui/term.js';
import { DatasetError, loadDataset } from './bench/dataset.js';
import { BenchError } from './bench/run.js';
import { SAMPLE_PATH, listDatasets, runBenchJob, validateBenchParams } from './bench/service.js';
import { createBenchResponder } from './mock/bench-responder.js';

/** Exit codes. */
export const EXIT = { OK: 0, BELOW_THRESHOLD: 1, USAGE: 2, RUNTIME: 3 };

const HELP = `assay ${VERSION}: audit agent for the Orbio gateway

Usage
  assay run       [--models a,b] [--max-spend 0.25] [--narrate] [--narrate-model id] [--fail-under N] [--json]
  assay watch     [--every 30m] [--alert-below 900] [--webhook URL] [--max-runs N]
  assay serve     [--port 4477]
  assay export    [--out scorecard.html] [--public]
  assay bench     --current <model> [--sample | --data file.jsonl] [--candidates auto|a,b] [--margin 5] [--limit N] [--dry-run]
  assay estimate  [path] [--input-mtok N] [--output-mtok N] [--discount 22.5] [--fee 5] [--book] [--catalog file] [--json]
  assay probe     Print redacted raw API shapes (use this if a live check misparses)
  assay demo      [--bench] [--fault overcharge|swap|inflate|lag|coarse|nostreamusage|notools|noauthcheck|clean] [--serve]

Environment (a .env file in the working directory is read automatically)
  ORBIO_API_KEY         your Orbio key (never accepted as a flag, so it stays out of shell history)
  ORBIO_BASE_URL        default ${DEFAULT_BASE_URL}
  ASSAY_BASELINE_KEY    optional direct OpenRouter key: enables the independent latency A/B
  ASSAY_MAX_SPEND_USD   hard spend cap for an audit, default 0.25

Exit codes: 0 ok · 1 below --fail-under · 2 usage or config error · 3 runtime failure
`;

const COMMON = {
  dir: { type: 'string' },
  'base-url': { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
};

/**
 * @param {string[]} argv
 * @param {{out?: NodeJS.WritableStream, err?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { out = process.stdout, err = process.stderr, env = process.env } = {}) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out.write(HELP);
    return EXIT.OK;
  }
  if (command === '--version' || command === '-V' || command === 'version') {
    out.write(`${VERSION}\n`);
    return EXIT.OK;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    err.write(`Unknown command "${command}".\n\n${HELP}`);
    return EXIT.USAGE;
  }

  try {
    if (env === process.env) loadDotenv();
    return await handler(rest, { out, err, env });
  } catch (e) {
    if (e instanceof ConfigError || e instanceof DatasetError || e instanceof BenchError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      err.write(`Error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    err.write(`Error: ${redact(e?.message ?? String(e), [env.ORBIO_API_KEY ?? '', env.ASSAY_BASELINE_KEY ?? ''])}\n`);
    if (env.ASSAY_DEBUG) err.write(`${redact(e?.stack ?? '', [env.ORBIO_API_KEY ?? ''])}\n`);
    return EXIT.RUNTIME;
  }
}

/** @param {string[]} args @param {Record<string, any>} options */
function parse(args, options, allowPositionals = false) {
  return parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals, strict: true });
}

/* ---------- run ---------- */

/** Progress on stderr: rewrites one line on a TTY, plain lines otherwise. */
function progressPrinter(err, t) {
  return (e) => {
    if (e.phase === 'done') {
      if (t.enabled) err.write('\r\x1b[K');
      return;
    }
    const line = `  ${t.c.dim('…')} ${e.message}`;
    err.write(t.enabled ? `\r\x1b[K${line}` : `${line}\n`);
  };
}

async function auditOnce(config, { err, t, quiet = false }) {
  const { report, catalog } = await runAudit({ config, onProgress: quiet ? () => {} : progressPrinter(err, t) });
  const store = createStore(config.dir);
  const savedPath = store.saveReport(report);
  if (catalog) store.saveCatalog({ host: report.gateway.host, priceUnit: catalog.priceUnit }, catalog.models);
  return { report, savedPath };
}

async function cmdRun(args, { out, err, env }) {
  const { values } = parse(args, {
    models: { type: 'string' }, 'max-spend': { type: 'string' }, narrate: { type: 'boolean' }, 'narrate-model': { type: 'string' },
    'fail-under': { type: 'string' },
  });
  if (values.help) return out.write(HELP), EXIT.OK;
  const failUnder = values['fail-under'] === undefined ? null : Number(values['fail-under']);
  if (failUnder !== null && !Number.isFinite(failUnder)) throw new ConfigError('--fail-under must be a number between 0 and 1000');

  const config = resolveConfig({ ...values, narrate: values['narrate-model'] ?? values.narrate ?? false }, env);
  const t = makeTerm(err, env);
  const { report, savedPath } = await auditOnce(config, { err, t });

  if (values.json) out.write(`${JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  else out.write(renderReport(report, makeTerm(out, env), { savedPath, dir: config.dir }));

  if (failUnder !== null && (report.score.fineness ?? 0) < failUnder) {
    err.write(`Fineness ${report.score.fineness ?? 'n/a'} is below --fail-under ${failUnder}.\n`);
    return EXIT.BELOW_THRESHOLD;
  }
  return EXIT.OK;
}

/* ---------- watch ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdWatch(args, { out, err, env }) {
  const { values } = parse(args, {
    every: { type: 'string' }, 'alert-below': { type: 'string' }, webhook: { type: 'string' }, 'max-runs': { type: 'string' }, 'max-spend': { type: 'string' }, models: { type: 'string' },
  });
  if (values.help) return out.write(HELP), EXIT.OK;
  const every = parseDuration(values.every ?? '30m');
  if (every < 60_000) throw new ConfigError('--every must be at least 1m: each run spends real credit');
  const alertBelow = values['alert-below'] === undefined ? null : Number(values['alert-below']);
  const maxRuns = values['max-runs'] ? Number(values['max-runs']) : Infinity;
  let webhook = null;
  if (values.webhook) {
    try { webhook = new URL(values.webhook); } catch { throw new ConfigError('--webhook must be a URL'); }
    if (!/^https?:$/.test(webhook.protocol)) throw new ConfigError('--webhook must be http(s)');
  }

  const config = resolveConfig(values, env);
  const t = makeTerm(out, env);
  let stop = false;
  process.once('SIGINT', () => { stop = true; });
  let previous = null;

  for (let run = 1; run <= maxRuns && !stop; run++) {
    try {
      const { report } = await auditOnce(config, { err, t, quiet: true });
      const failing = report.checks.filter((c) => c.status === 'fail').map((c) => c.id);
      const stamp = new Date().toISOString().slice(11, 19);
      out.write(`${t.c.dim(stamp)}  fineness ${t.c.bold(String(report.score.fineness ?? '—'))}  ${report.score.grade}${failing.length ? t.c.red(`  failing: ${failing.join(', ')}`) : ''}\n`);

      const regressed = previous !== null && ((report.score.fineness ?? 0) < (previous.score.fineness ?? 0) - 50 || failing.some((id) => previous.checks.find((c) => c.id === id)?.status !== 'fail'));
      const below = alertBelow !== null && (report.score.fineness ?? 0) < alertBelow;
      if ((regressed || below) && webhook) await notify(webhook, report, failing, below ? `below ${alertBelow}` : 'regressed', err);
      previous = report;
    } catch (e) {
      err.write(`run ${run} failed: ${redact(e.message, [config.apiKey])}\n`);
    }
    if (run < maxRuns && !stop) await sleepUnlessStopped(every, () => stop);
  }
  return EXIT.OK;
}

async function sleepUnlessStopped(ms, isStopped) {
  const end = Date.now() + ms;
  while (Date.now() < end && !isStopped()) await sleep(Math.min(1000, end - Date.now()));
}

/** Slack-compatible `text` plus structured fields. Never includes keys or prompts. */
async function notify(url, report, failing, reason, err) {
  const text = `Assay: fineness ${report.score.fineness ?? 'n/a'} (${report.score.grade}) ${reason}${failing.length ? `; failing: ${failing.join(', ')}` : ''}. ${report.headline}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, fineness: report.score.fineness, grade: report.score.grade, failing, reportId: report.id }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) err.write(`webhook returned ${res.status}\n`);
  } catch (e) {
    err.write(`webhook failed: ${e.message}\n`);
  }
}

/* ---------- serve / export ---------- */

function dashboardFor(config, store, { runner, benchRunner = null, liveCatalog }) {
  return createDashboardServer({ store, runner, benchRunner, liveCatalog });
}

async function cmdServe(args, { out, err, env }) {
  const { values } = parse(args, { port: { type: 'string' }, models: { type: 'string' }, 'max-spend': { type: 'string' } });
  if (values.help) return out.write(HELP), EXIT.OK;
  const config = resolveConfig(values, env, { requireKey: false });
  const store = createStore(config.dir);
  const port = values.port === undefined ? 4477 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('--port must be 0–65535');

  const client = config.apiKey ? new OrbioClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs, label: 'Orbio' }) : null;
  const dash = dashboardFor(config, store, {
    runner: config.apiKey ? (onProgress) => runAudit({ config, onProgress }) : null,
    benchRunner: client ? (params, onProgress) => runBenchJob({ config, client, store, params, onProgress }) : null,
    liveCatalog: client
      ? async () => {
          const res = await client.get('/models');
          return res.ok ? toPriced(normalizeCatalog(res.json, { priceUnit: config.priceUnit }).models) : null;
        }
      : null,
  });
  const addr = await dash.listen(port);
  out.write(`\n  Assay dashboard  http://localhost:${addr.port}\n  ${config.apiKey ? 'Run audit is enabled.' : 'No ORBIO_API_KEY: read-only (reports and the stored catalog).'}  Ctrl+C to stop.\n\n`);
  await new Promise((r) => process.once('SIGINT', r));
  await dash.close();
  return EXIT.OK;
}

async function cmdExport(args, { out, err, env }) {
  const { values } = parse(args, { out: { type: 'string' }, public: { type: 'boolean' } });
  if (values.help) return out.write(HELP), EXIT.OK;
  const store = createStore(values.dir ?? env.ASSAY_DIR ?? '.assay');
  const report = store.loadLatest();
  if (!report) throw new ConfigError('No report to export yet. Run `assay run` first.');
  const snapshot = store.loadCatalog();
  const html = buildStaticHtml({ report, bench: store.loadLatestBench(), history: store.loadHistory(), catalog: snapshot ? toPriced(snapshot.models) : [], public: Boolean(values.public) });
  const file = resolve(values.out ?? 'scorecard.html');
  writeFileSync(file, html);
  out.write(`Wrote ${file} (${(html.length / 1024).toFixed(0)} KB). It is one self-contained file: open it, attach it, or host it.\n`);
  return EXIT.OK;
}


/* ---------- bench ---------- */

async function cmdBench(args, { out, err, env }) {
  const { values } = parse(args, {
    data: { type: 'string' }, sample: { type: 'boolean' }, current: { type: 'string' }, candidates: { type: 'string' }, judge: { type: 'string' },
    limit: { type: 'string' }, 'max-tokens': { type: 'string' }, margin: { type: 'string' }, 'max-spend': { type: 'string' },
    concurrency: { type: 'string' }, rpm: { type: 'string' }, 'no-samples': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  });
  if (values.help) return out.write(HELP), EXIT.OK;
  if (!values.current) throw new ConfigError('--current <model> is required: the model you use today, e.g. --current openai/gpt-6-astra');
  if (!values.data && !values.sample) throw new ConfigError('Provide --data <file.jsonl>, or --sample to use the bundled support-ticket dataset.');
  if (values.data && values.sample) throw new ConfigError('Use either --data or --sample, not both.');

  const int = (v, label, lo, hi) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new ConfigError(`${label} must be between ${lo} and ${hi}`);
    return n;
  };
  const spend = values['max-spend'] ?? env.ASSAY_MAX_SPEND_USD ?? '1.00'; // a benchmark makes many calls, so its default cap is higher than an audit's
  const config = resolveConfig({ ...values, 'max-spend': spend }, env);
  const dataset = values.sample ? loadDataset(SAMPLE_PATH) : loadDataset(values.data);
  const params = {
    current: values.current,
    candidates: !values.candidates || values.candidates === 'auto' ? 'auto' : values.candidates.split(',').map((s) => s.trim()).filter(Boolean),
    judge: values.judge ?? null,
    limit: int(values.limit, '--limit', 5, 1000),
    maxTokens: int(values['max-tokens'], '--max-tokens', 8, 4000),
    marginPts: int(values.margin, '--margin', 1, 30) ?? 5,
    concurrency: int(values.concurrency, '--concurrency', 1, 16),
    rpm: int(values.rpm, '--rpm', 0, 600),
    samples: !values['no-samples'],
    dryRun: Boolean(values['dry-run']),
    maxSpend: Number(spend),
  };
  if (!Number.isFinite(params.maxSpend) || params.maxSpend <= 0) throw new ConfigError('--max-spend must be a positive dollar amount');

  const t = makeTerm(err, env);
  const store = createStore(config.dir);
  const client = new OrbioClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs, label: 'Orbio' });
  const result = await runBenchJob({
    config, client, store, params, dataset, datasetName: values.sample ? 'Support tickets (sample)' : values.data.split('/').pop(),
    onProgress: progressPrinter(err, t),
  });
  if (t.enabled) err.write('\r\x1b[K');

  if (result.plan && !result.report) {
    out.write(values.json ? `${JSON.stringify(result.plan, null, 2)}\n` : renderBenchPlan(result.plan, makeTerm(out, env)));
    return EXIT.OK;
  }
  out.write(values.json ? `${JSON.stringify(result.report, null, 2)}\n` : renderBench(result.report, makeTerm(out, env), { savedPath: result.savedPath, dir: config.dir }));
  return EXIT.OK;
}

/* ---------- estimate ---------- */

function loadCatalogFile(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(json?.data ?? json)) return toPriced(normalizeCatalog(json).models);
  if (Array.isArray(json?.models)) return toPriced(json.models);
  throw new ConfigError(`${path} is not an OpenRouter-style /models payload or an Assay catalog snapshot`);
}

const pct = (v, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n >= 100) throw new ConfigError(`${label} must be a percentage between 0 and 100`);
  return n / 100;
};
const mtok = (v, label) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${label} must be a non-negative number (millions of tokens per month)`);
  return n;
};

async function cmdEstimate(args, { out, err, env }) {
  const { values, positionals } = parse(args, {
    'input-mtok': { type: 'string' }, 'output-mtok': { type: 'string' }, discount: { type: 'string' }, fee: { type: 'string' },
    book: { type: 'boolean' }, catalog: { type: 'string' },
  }, true);
  if (values.help) return out.write(HELP), EXIT.OK;

  const config = resolveConfig(values, env, { requireKey: false });
  const store = createStore(config.dir);

  let catalog;
  if (values.catalog) {
    catalog = loadCatalogFile(values.catalog);
  } else if (config.apiKey) {
    const res = await new OrbioClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs }).get('/models');
    catalog = res.ok ? toPriced(normalizeCatalog(res.json, { priceUnit: config.priceUnit }).models) : [];
  }
  if (!catalog?.length) {
    const snap = store.loadCatalog();
    if (snap) {
      catalog = toPriced(snap.models);
      err.write(`Using the catalog snapshot from ${snap.savedAt}.\n`);
    }
  }
  if (!catalog?.length) throw new ConfigError('No model catalog available. Set ORBIO_API_KEY, run `assay run` once, or pass --catalog <file>.');

  const result = estimateRepo({
    path: positionals[0] ?? '.', catalog,
    inputMtok: mtok(values['input-mtok'], '--input-mtok'), outputMtok: mtok(values['output-mtok'], '--output-mtok'),
    ...(values.discount !== undefined && { discount: pct(values.discount, '--discount') }),
    ...(values.fee !== undefined && { fee: pct(values.fee, '--fee') }),
    book: Boolean(values.book),
  });

  const orbioBase = config.baseUrl;
  if (values.json) {
    out.write(`${JSON.stringify({ ...result, migration: migrationHints(result.endpoints, orbioBase) }, null, 2)}\n`);
  } else {
    out.write(renderEstimate(result, makeTerm(out, env), orbioBase));
  }
  return EXIT.OK;
}

/* ---------- probe ---------- */

/** Show raw shapes, redacted, so a live mismatch can be diagnosed in one paste. */
async function cmdProbe(args, { out, err, env }) {
  const { values } = parse(args, { models: { type: 'string' } });
  if (values.help) return out.write(HELP), EXIT.OK;
  const config = resolveConfig(values, env);
  const client = new OrbioClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs, label: 'Orbio' });
  const show = (title, obj) => out.write(`\n=== ${title}\n${redact(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), [config.apiKey])}\n`);

  out.write(`Assay probe · ${config.baseUrl}\nPaste everything below if a check misreads your gateway. Keys are redacted.\n`);

  const key = await client.get('/key');
  show('GET /key', { status: key.status, headers: key.headers, body: key.json ?? key.text });
  const compat = await client.get('/auth/key');
  show('GET /auth/key', { status: compat.status, body: compat.json ?? compat.text });

  const models = await client.get('/models');
  const list = models.json?.data ?? models.json;
  show('GET /models', {
    status: models.status,
    topLevelKeys: models.json && typeof models.json === 'object' ? Object.keys(models.json) : null,
    count: Array.isArray(list) ? list.length : null,
    firstEntry: Array.isArray(list) ? list[0] : clip(models.text, 400),
    entryKeys: Array.isArray(list) && list[0] ? Object.keys(list[0]) : null,
  });

  const catalog = normalizeCatalog(models.json, { priceUnit: config.priceUnit });
  const { selected } = selectAuditModels(catalog.models, { explicit: config.models, count: 1 });
  if (!selected.length) {
    out.write('\nNo auditable model found; skipping chat probes.\n');
    return EXIT.OK;
  }
  const model = selected[0];
  show('Detected', { priceUnit: catalog.priceUnit, chosenModel: model.id, promptPricePerToken: model.promptPrice?.toString(), issues: catalog.issues.slice(0, 5) });

  const chat = await client.chat({ model: model.id, messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 8, temperature: 0 });
  show(`POST /chat/completions (${model.id})`, { status: chat.status, headers: chat.headers, bodyKeys: chat.json ? Object.keys(chat.json) : null, model: chat.json?.model, id: chat.json?.id, usage: chat.json?.usage, error: chat.json?.error ?? undefined, text: chat.ok ? undefined : chat.text });

  const stream = await client.chatStream({ model: model.id, messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 8, temperature: 0 });
  show('Streaming', { status: stream.status, events: stream.events, doneSeen: stream.doneSeen, usage: stream.usage, firstChunk: stream.chunks[0], lastChunk: stream.chunks.at(-1), errorText: stream.errorText });

  const after = await client.get('/key');
  show('GET /key after the calls', { balance: after.json?.balance ?? after.json });
  return EXIT.OK;
}

/* ---------- demo ---------- */

async function cmdDemo(args, { out, err, env }) {
  const { values } = parse(args, { fault: { type: 'string' }, serve: { type: 'boolean' }, bench: { type: 'boolean' }, port: { type: 'string' } });
  if (values.help) return out.write(HELP), EXIT.OK;
  // The integrated story wants a healthy gateway first: verify it, then benchmark on it.
  const faults = (values.fault ?? (values.bench ? 'clean' : 'overcharge')).split(',').map((s) => s.trim()).filter((f) => f && f !== 'clean');

  const sample = loadDataset(SAMPLE_PATH);
  const mock = await createMockGateway({ faults, respond: createBenchResponder(sample), latencyMs: 8, jitterMs: 4 });
  const base = { ...resolveConfig({ key: MOCK_KEY, 'base-url': mock.baseUrl, dir: values.dir ?? '.assay-demo', verbose: values.verbose, 'max-spend': '5' }, {}), settleTimeoutMs: 5000, settlePollMs: 100 };
  const t = makeTerm(err, env);
  out.write(`\n  Demo: a built-in fake gateway${faults.length ? ` with the fault "${faults.join(', ')}"` : ', healthy'}.\n  No key, no network, no cost. Try --bench, or --fault swap | inflate | lag | coarse | clean.\n`);

  try {
    const store = createStore(base.dir);
    const client = new OrbioClient({ baseUrl: base.baseUrl, apiKey: MOCK_KEY, label: 'demo' });
    const { report, savedPath } = await auditOnce(base, { err, t });
    out.write(renderReport(report, makeTerm(out, env), { savedPath, dir: base.dir }));

    const benchParams = { current: 'openai/gpt-6-astra', candidates: ['anthropic/claude-haiku-4.5', 'google/gemini-3.8-flash', 'openai/gpt-6-mini', 'deepseek/deepseek-v4-flash'], marginPts: 5, rpm: 0, concurrency: 6, maxSpend: 5 };
    if (values.bench) {
      const result = await runBenchJob({ config: base, client, store, params: benchParams, dataset: sample, datasetName: 'Support tickets (sample)', onProgress: progressPrinter(err, t) });
      if (t.enabled) err.write('\r\x1b[K');
      out.write(renderBench(result.report, makeTerm(out, env), { savedPath: result.savedPath, dir: base.dir }));
    }
    if (!values.serve) return EXIT.OK;

    const dash = dashboardFor(base, store, {
      runner: (onProgress) => runAudit({ config: base, onProgress }),
      benchRunner: (params, onProgress) => runBenchJob({ config: base, client, store, params: { ...params, rpm: 0, concurrency: 6 }, onProgress }),
      liveCatalog: null,
    });
    const addr = await dash.listen(values.port === undefined ? 4477 : Number(values.port));
    out.write(`  Dashboard  http://localhost:${addr.port}   (Run audit and Run benchmark both work against the fake gateway)  Ctrl+C to stop.\n\n`);
    await new Promise((r) => process.once('SIGINT', r));
    await dash.close();
    return EXIT.OK;
  } finally {
    await mock.close();
  }
}

const COMMANDS = { run: cmdRun, bench: cmdBench, watch: cmdWatch, serve: cmdServe, export: cmdExport, estimate: cmdEstimate, probe: cmdProbe, demo: cmdDemo };
