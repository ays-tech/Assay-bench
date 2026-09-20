import { formatDecimal } from './decimal.js';

export class BudgetExceededError extends Error {
  constructor(spent, cap, needed) {
    super(`Spend cap reached: $${formatDecimal(spent)} spent + $${formatDecimal(needed)} needed exceeds $${formatDecimal(cap)}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Hard spend guard. Every paid call must `reserve()` its worst-case cost first; the actual
 * cost replaces the reservation afterwards. Amounts are scaled decimals (see decimal.js).
 */
export class Budget {
  /** @param {bigint} cap */
  constructor(cap) {
    this.cap = cap;
    this.spent = 0n;
    this.calls = 0;
  }

  /** @returns {bigint} */
  get remaining() {
    return this.cap - this.spent;
  }

  /**
   * Reserve worst-case cost; throws if it cannot fit.
   * @param {bigint} worstCase
   * @returns {(actual: bigint|null) => void} settle function
   */
  reserve(worstCase) {
    if (this.spent + worstCase > this.cap) throw new BudgetExceededError(this.spent, this.cap, worstCase);
    this.spent += worstCase;
    this.calls += 1;
    let settled = false;
    return (actual) => {
      if (settled) return;
      settled = true;
      // If the actual cost is unknown (failed call), keep the worst case: err on the side of caution.
      if (actual !== null) this.spent += actual - worstCase;
    };
  }
}
