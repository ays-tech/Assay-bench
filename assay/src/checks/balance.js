import { tryParseDecimal } from '../decimal.js';

/**
 * @typedef {object} BalanceReading
 * @property {bigint|null} available
 * @property {bigint|null} used
 * @property {string|null} availableRaw
 * @property {string|null} usedRaw
 * @property {{requestsPerMinute:number|null, concurrent:number|null}|null} rateLimit
 * @property {'orbio'|'openrouter'|null} shape
 */

/**
 * Parse the body of `GET /key` (Orbio shape) or `GET /auth/key` (OpenRouter shape).
 * Pure; never throws.
 * @param {any} json
 * @returns {BalanceReading}
 */
export function parseKeyResponse(json) {
  const empty = { available: null, used: null, availableRaw: null, usedRaw: null, rateLimit: null, shape: null };
  if (!json || typeof json !== 'object') return empty;

  if (json.balance && typeof json.balance === 'object') {
    const rl = json.rate_limit;
    // Orbio also reports exact integer micro-USD. Prefer it: the decimal strings can be rounded
    // to fewer places (the live gateway shows "49.76262"), which would coarsen our resolution.
    const availableMicro = fromMicro(json.balance.available_micro_usd);
    const usedMicro = fromMicro(json.balance.used_micro_usd);
    return {
      available: availableMicro?.value ?? tryParseDecimal(json.balance.available),
      used: usedMicro?.value ?? tryParseDecimal(json.balance.used),
      availableRaw: availableMicro?.raw ?? asRaw(json.balance.available),
      usedRaw: usedMicro?.raw ?? asRaw(json.balance.used),
      rateLimit: rl && typeof rl === 'object'
        ? { requestsPerMinute: numOrNull(rl.requests_per_minute), concurrent: numOrNull(rl.concurrent) }
        : null,
      shape: 'orbio',
    };
  }

  const data = json.data;
  if (data && typeof data === 'object' && 'limit_remaining' in data) {
    return {
      available: tryParseDecimal(data.limit_remaining),
      used: tryParseDecimal(data.usage),
      availableRaw: asRaw(data.limit_remaining),
      usedRaw: asRaw(data.usage),
      rateLimit: null,
      shape: 'openrouter',
    };
  }
  return empty;
}

/**
 * Read the live balance.
 * @param {import('../client.js').OrbioClient} client
 * @returns {Promise<BalanceReading & {status:number}>}
 */
export async function readBalance(client) {
  const res = await client.get('/key');
  return { ...parseKeyResponse(res.json), status: res.status };
}

/**
 * "49762620" micro-USD → exact scaled decimal plus a 6-place string for resolution detection.
 * @param {unknown} v
 */
function fromMicro(v) {
  const text = typeof v === 'number' && Number.isInteger(v) ? String(v) : v;
  if (typeof text !== 'string' || !/^-?\d+$/.test(text)) return null;
  const micro = BigInt(text);
  const negative = micro < 0n;
  const digits = (negative ? -micro : micro).toString().padStart(7, '0');
  const raw = `${negative ? '-' : ''}${digits.slice(0, -6)}.${digits.slice(-6)}`;
  return { value: tryParseDecimal(raw), raw };
}

/** @param {unknown} v */
function asRaw(v) {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}
/** @param {unknown} v */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
