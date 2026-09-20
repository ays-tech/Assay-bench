import { parseDecimal } from './decimal.js';

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://api.orbio.so/api/v1';
export const DEFAULT_BASELINE_URL = 'https://openrouter.ai/api/v1';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load `.env` from the working directory if present (Node ≥ 20.12), without overriding
 * variables that are already set in the environment.
 */
export function loadDotenv(path = '.env') {
  try {
    process.loadEnvFile?.(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new ConfigError(`Could not read ${path}: ${err.message}`);
  }
}

/**
 * @typedef {object} Config
 * @property {string} apiKey
 * @property {string} baseUrl
 * @property {string} [baselineKey]
 * @property {string} baselineUrl
 * @property {string} dir
 * @property {string[]} models
 * @property {bigint} maxSpend         scaled decimal (USD)
 * @property {number} timeoutMs
 * @property {number} tolerance        billing tolerance as a fraction (0.02 = 2 %)
 * @property {number} minRounds        minimum canary rounds per model in a billing batch
 * @property {number} maxRounds        cap on rounds per batch
 * @property {number} settleTimeoutMs  how long to wait for a charge to land
 * @property {number} settlePollMs
 * @property {false|true|string} narrate
 * @property {boolean} verbose
 * @property {'auto'|'per_token'|'per_million'} priceUnit
 */

/**
 * Merge CLI flags and environment into a validated config. Flags win over env.
 * @param {Record<string, any>} flags
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{requireKey?: boolean}} [opts]
 * @returns {Config}
 */
export function resolveConfig(flags = {}, env = process.env, { requireKey = true } = {}) {
  const apiKey = String(flags.key ?? env.ORBIO_API_KEY ?? '').trim();
  if (requireKey && !apiKey) {
    throw new ConfigError('ORBIO_API_KEY is not set. Put it in .env or export it (see .env.example).');
  }

  const baseUrl = normalizeUrl(flags['base-url'] ?? env.ORBIO_BASE_URL ?? DEFAULT_BASE_URL, 'ORBIO_BASE_URL');
  const baselineUrl = normalizeUrl(env.ASSAY_BASELINE_URL ?? DEFAULT_BASELINE_URL, 'ASSAY_BASELINE_URL');
  const baselineKey = String(env.ASSAY_BASELINE_KEY ?? '').trim() || undefined;

  const spendText = String(flags['max-spend'] ?? env.ASSAY_MAX_SPEND_USD ?? '0.25');
  let maxSpend;
  try {
    maxSpend = parseDecimal(spendText);
  } catch {
    throw new ConfigError(`--max-spend must be a dollar amount, got "${spendText}"`);
  }
  if (maxSpend <= 0n) throw new ConfigError('--max-spend must be greater than zero');

  const modelsText = String(flags.models ?? env.ASSAY_MODELS ?? '');
  const models = modelsText.split(',').map((s) => s.trim()).filter(Boolean);

  const priceUnit = String(env.ASSAY_PRICE_UNIT ?? 'auto');
  if (!['auto', 'per_token', 'per_million'].includes(priceUnit)) {
    throw new ConfigError('ASSAY_PRICE_UNIT must be auto, per_token or per_million');
  }

  return {
    apiKey,
    baseUrl,
    baselineKey,
    baselineUrl,
    dir: String(flags.dir ?? env.ASSAY_DIR ?? '.assay'),
    models,
    maxSpend,
    timeoutMs: positiveInt(flags.timeout ?? env.ASSAY_TIMEOUT_MS, 45_000, 'timeout'),
    tolerance: 0.02,
    minRounds: 2,
    maxRounds: 6,
    settleTimeoutMs: positiveInt(env.ASSAY_SETTLE_TIMEOUT_MS, 8_000, 'ASSAY_SETTLE_TIMEOUT_MS'),
    settlePollMs: 300,
    narrate: flags.narrate ?? false,
    verbose: Boolean(flags.verbose),
    priceUnit: /** @type {any} */ (priceUnit),
  };
}

/** @param {string} raw @param {string} label */
function normalizeUrl(raw, label) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ConfigError(`${label} is not a valid URL: ${raw}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new ConfigError(`${label} must be http(s)`);
  return url.toString().replace(/\/+$/, '');
}

/** @param {unknown} v @param {number} fallback @param {string} label */
function positiveInt(v, fallback, label) {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${label} must be a positive integer`);
  return n;
}

/**
 * Parse durations like "90s", "30m", "6h" into milliseconds.
 * @param {string} text
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(text).trim());
  if (!m) throw new ConfigError(`Invalid duration "${text}" (try 30s, 15m, 6h)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'];
  return Math.round(Number(m[1]) * unit);
}
