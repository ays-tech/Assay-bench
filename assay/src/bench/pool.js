/** Bounded concurrency plus a requests-per-minute ceiling, so a benchmark never trips the gateway's rate limit. */

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving result order.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Returns `wait()`: resolves when the caller may start another request, spacing starts at
 * least 60000/rpm ms apart across ALL workers.
 * @param {number} rpm @param {{now?: () => number, sleep?: (ms: number) => Promise<void>}} [clock]
 */
export function createRateLimiter(rpm, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const interval = rpm > 0 ? 60_000 / rpm : 0;
  let nextSlot = 0;
  return async function wait() {
    if (!interval) return;
    const t = now();
    const slot = Math.max(t, nextSlot);
    nextSlot = slot + interval;
    if (slot > t) await sleep(slot - t);
  };
}
