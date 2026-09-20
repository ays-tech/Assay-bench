/**
 * Fixed-point decimals on BigInt.
 *
 * Money in an audit must be exact: floating point error would be indistinguishable
 * from a billing discrepancy. Values are stored as integers scaled by 10^18, which
 * comfortably represents per-token prices (~1e-9) multiplied by millions of tokens.
 */

export const SCALE = 18;
export const ONE = 10n ** BigInt(SCALE);

const DECIMAL_RE = /^\s*([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/;

/**
 * Parse a decimal string/number into a scaled bigint, or null if invalid.
 * Accepts "12.34", "-0.5", ".5", "1.5e-7", and finite numbers.
 * @param {string|number|bigint|null|undefined} input
 * @returns {bigint|null}
 */
export function tryParseDecimal(input) {
  if (typeof input === 'bigint') return input * ONE;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    input = String(input);
  }
  if (typeof input !== 'string') return null;
  const m = DECIMAL_RE.exec(input);
  if (!m) return null;
  const intPart = m[2] ?? '';
  const fracPart = m[3] ?? '';
  if (intPart === '' && fracPart === '') return null;
  const exp = Number(m[4] ?? 0);
  if (!Number.isInteger(exp) || Math.abs(exp) > 60) return null;

  const digits = BigInt(intPart + fracPart || '0');
  const shift = SCALE + exp - fracPart.length;
  let value = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  if (m[1] === '-') value = -value;
  return value;
}

/**
 * @param {string|number|bigint} input
 * @returns {bigint}
 */
export function parseDecimal(input) {
  const v = tryParseDecimal(input);
  if (v === null) throw new TypeError(`Not a decimal: ${JSON.stringify(input)}`);
  return v;
}

/**
 * Number of digits after the decimal point in a plain decimal string ("12.3400" → 4).
 * Returns 0 for integers and for non-strings.
 * @param {unknown} str
 */
export function decimalPlaces(str) {
  if (typeof str !== 'string') return 0;
  const m = /^\s*[+-]?\d*\.(\d+)\s*$/.exec(str);
  return m ? m[1].length : 0;
}

/**
 * The smallest representable step of the most precise string in the list.
 * @param {Array<string|null|undefined>} strings
 * @returns {bigint} scaled resolution (10^-dp)
 */
export function resolutionOf(strings) {
  let dp = 0;
  for (const s of strings) dp = Math.max(dp, decimalPlaces(s));
  return 10n ** BigInt(SCALE - Math.min(dp, SCALE));
}

/**
 * Round-half-up to `dp` places and render, e.g. formatDecimal(x, 6) → "0.014200".
 * @param {bigint} value
 * @param {number} [dp]
 */
export function formatDecimal(value, dp = 6) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const factor = 10n ** BigInt(SCALE - dp);
  const q = (abs + factor / 2n) / factor;
  const unit = 10n ** BigInt(dp);
  const whole = q / unit;
  const frac = (q % unit).toString().padStart(dp, '0');
  return `${negative ? '-' : ''}${whole}${dp > 0 ? `.${frac}` : ''}`;
}

/** @param {bigint} value */
export function toNumber(value) {
  return Number(value) / Number(ONE);
}

/**
 * a / b as a JS number; null when b is zero.
 * @param {bigint} a @param {bigint} b
 */
export function ratio(a, b) {
  if (b === 0n) return null;
  return Number(a) / Number(b);
}

/** @param {bigint} v */
export const abs = (v) => (v < 0n ? -v : v);
/** @param {bigint} a @param {bigint} b */
export const max = (a, b) => (a > b ? a : b);
/** @param {bigint} a @param {bigint} b */
export const min = (a, b) => (a < b ? a : b);

/**
 * value × factor where factor is a plain JS number (e.g. a 0.02 tolerance).
 * Uses 1e-9 granularity, ample for tolerances.
 * @param {bigint} value @param {number} factor
 */
export function scaleBy(value, factor) {
  return (value * BigInt(Math.round(factor * 1e9))) / 1_000_000_000n;
}
