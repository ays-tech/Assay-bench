/**
 * Savings model, shared by the CLI (Node) and the dashboard (browser).
 * Plain numbers on purpose: this is an estimate, not an audit, so floating point is fine here.
 *
 * How Orbio pricing works (orbio.so FAQ):
 *   - Usage is metered at each model's catalog rate; 1 CREDIT = $1 of usage.
 *   - The discount is earned when BUYING credit from the liquidity book.
 *   - A platform fee of 5 % of the discounted credit price is added at purchase.
 *
 *   cash cost  = usage × (1 − discount) × (1 + fee)
 */

export const PLATFORM_FEE = 0.05;
/** Orbio's own headline example on the buy page. */
export const HEADLINE_DISCOUNT = 0.225;

/**
 * A dated snapshot of the public liquidity book (credits available per discount tier).
 * The live book changes constantly; treat this as an illustration of depth, not a quote.
 */
export const BOOK_SNAPSHOT = Object.freeze({
  takenAt: '2026-09-20',
  source: 'orbio.so buy page',
  tiers: Object.freeze([
    { discount: 0.25, usd: 55 },
    { discount: 0.2, usd: 4666 },
    { discount: 0.15, usd: 6785 },
    { discount: 0.1, usd: 14231 },
    { discount: 0.05, usd: 10706 },
    { discount: 0, usd: 114 },
  ]),
});

/**
 * Blended discount for buying `purchaseUsd` of credit, filling the best tiers first.
 * If the book is shallower than the purchase, `shortfall` is the part it cannot fill.
 *
 * @param {ReadonlyArray<{discount:number, usd:number}>} tiers
 * @param {number} purchaseUsd
 * @returns {{discount:number, covered:number, shortfall:number, filled:Array<{discount:number, usd:number}>}}
 */
export function blendedDiscount(tiers, purchaseUsd) {
  const sorted = [...tiers].sort((a, b) => b.discount - a.discount);
  let remaining = Math.max(0, purchaseUsd);
  let pay = 0;
  const filled = [];
  for (const tier of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, tier.usd);
    pay += take * (1 - tier.discount);
    filled.push({ discount: tier.discount, usd: take });
    remaining -= take;
  }
  const covered = Math.max(0, purchaseUsd) - remaining;
  if (covered <= 0) return { discount: sorted[0]?.discount ?? 0, covered: 0, shortfall: Math.max(0, purchaseUsd), filled };
  return { discount: 1 - pay / covered, covered, shortfall: remaining, filled };
}

/** @param {number} usage @param {number} discount @param {number} [fee] */
export const cashCost = (usage, discount, fee = PLATFORM_FEE) => usage * (1 - discount) * (1 + fee);

/** Fraction saved after the fee. 22.5 % headline → 18.6 % net. */
export const netSaving = (discount, fee = PLATFORM_FEE) => 1 - (1 - discount) * (1 + fee);

/** Discount below which buying credit costs MORE than the usage it buys. */
export const breakEvenDiscount = (fee = PLATFORM_FEE) => 1 - 1 / (1 + fee);

/**
 * Catalog-rate cost of a monthly volume.
 * @param {{promptPrice:number, completionPrice:number}} model USD per token
 * @param {number} inputMtok @param {number} outputMtok millions of tokens per month
 */
export const usageCost = (model, inputMtok, outputMtok) =>
  model.promptPrice * inputMtok * 1e6 + model.completionPrice * outputMtok * 1e6;

/**
 * @typedef {object} WorkloadRow
 * @property {string} id
 * @property {number} promptPrice     USD per token
 * @property {number} completionPrice USD per token
 * @property {number} inputMtok       million input tokens per month
 * @property {number} outputMtok      million output tokens per month
 *
 * @param {WorkloadRow[]} rows
 * @param {{discount?: number, fee?: number, book?: ReadonlyArray<{discount:number,usd:number}>|null}} [opts]
 *   `book` overrides `discount`: the discount is blended for a purchase equal to the monthly usage.
 */
export function estimateWorkload(rows, { discount = HEADLINE_DISCOUNT, fee = PLATFORM_FEE, book = null } = {}) {
  const usage = rows.reduce((s, r) => s + usageCost(r, r.inputMtok, r.outputMtok), 0);
  let d = discount;
  let shortfall = 0;
  if (book) {
    const blended = blendedDiscount(book, usage);
    d = blended.discount;
    shortfall = blended.shortfall;
  }
  const cash = cashCost(usage, d, fee);
  return {
    discount: d,
    fee,
    usage,
    cash,
    saved: usage - cash,
    savedPct: usage > 0 ? (usage - cash) / usage : 0,
    annualSaved: (usage - cash) * 12,
    shortfall,
    breakEven: breakEvenDiscount(fee),
    rows: rows.map((r) => {
      const u = usageCost(r, r.inputMtok, r.outputMtok);
      return { id: r.id, usage: u, cash: cashCost(u, d, fee) };
    }),
  };
}

const usdFormats = {
  small: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 }),
  normal: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};

/** @param {number} n */
export function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
  return (Math.abs(n) > 0 && Math.abs(n) < 1 ? usdFormats.small : usdFormats.normal).format(n);
}

/** @param {number} n fraction, e.g. 0.186 → "18.6%" */
export const fmtPct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');
