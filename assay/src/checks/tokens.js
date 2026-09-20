import { CANARY_CHARS } from '../probe.js';
import { median } from '../stats.js';

const OVER_CAP_SLACK = 8;

/**
 * @typedef {{severity: 'fail'|'warn', kind: string, model: string, message: string}} Violation
 */

/**
 * Pure: check invariants that must hold for honest usage accounting, independent of price.
 * @param {import('../probe.js').CallRecord[]} records gateway records only
 * @returns {{violations: Violation[], checked: number, perModel: Record<string, number[]>}}
 */
export function evaluateTokens(records) {
  /** @type {Violation[]} */
  const violations = [];
  const ok = records.filter((r) => r.ok);
  /** @type {Record<string, number[]>} */
  const perModel = {};

  for (const r of ok) {
    if (r.promptTokens === null || r.completionTokens === null) {
      violations.push({ severity: 'warn', kind: 'missing-usage', model: r.model, message: `${r.model}: response has no usage block, so billing cannot be verified per call` });
      continue;
    }
    // A few tokens over the cap is a known provider quirk (stop tokens, hidden reasoning); far over is not.
    if (r.completionTokens > r.maxTokens) {
      const far = r.completionTokens > r.maxTokens + OVER_CAP_SLACK;
      violations.push({ severity: far ? 'fail' : 'warn', kind: 'completion-over-cap', model: r.model, message: `${r.model}: ${r.completionTokens} completion tokens reported for a max_tokens of ${r.maxTokens}` });
    }
    if (r.totalTokens !== null) {
      const diff = Math.abs(r.totalTokens - (r.promptTokens + r.completionTokens));
      if (diff > Math.max(2, 0.02 * r.totalTokens)) {
        const far = diff > Math.max(8, 0.1 * r.totalTokens);
        violations.push({ severity: far ? 'fail' : 'warn', kind: 'total-mismatch', model: r.model, message: `${r.model}: total_tokens ${r.totalTokens} ≠ prompt ${r.promptTokens} + completion ${r.completionTokens}` });
      }
    }
    if (r.tag === 'billing') {
      (perModel[r.model] ??= []).push(r.promptTokens);
      // English ASCII runs ~4 chars/token. Under 1.5 chars/token would be a gross inflation.
      if (r.promptTokens > CANARY_CHARS / 1.5) {
        violations.push({ severity: 'fail', kind: 'prompt-inflated', model: r.model, message: `${r.model}: ${r.promptTokens} prompt tokens for a ${CANARY_CHARS}-character English prompt (expected roughly ${Math.round(CANARY_CHARS / 4)})` });
      } else if (r.promptTokens < CANARY_CHARS / 8) {
        violations.push({ severity: 'warn', kind: 'prompt-implausibly-low', model: r.model, message: `${r.model}: only ${r.promptTokens} prompt tokens for a ${CANARY_CHARS}-character prompt` });
      }
    }
  }

  // Same prompt, same model → tokenization must be stable.
  for (const [model, counts] of Object.entries(perModel)) {
    if (Math.max(...counts) - Math.min(...counts) > 2) {
      violations.push({ severity: 'warn', kind: 'unstable', model, message: `${model}: prompt token count varied (${Math.min(...counts)}–${Math.max(...counts)}) for an identical prompt` });
    }
  }

  // Tokenizers differ, but not by 2×: flag the outlier when there are enough models to compare.
  const medians = Object.entries(perModel).map(([model, c]) => [model, median(c)]);
  if (medians.length >= 3) {
    const overall = median(medians.map(([, m]) => m));
    for (const [model, m] of medians) {
      if (m > 2 * overall) violations.push({ severity: 'warn', kind: 'cross-model-outlier', model, message: `${model}: ${m} prompt tokens vs a cross-model median of ${overall}` });
    }
  }

  return { violations, checked: ok.length, perModel };
}

/** @type {import('./index.js').Check} */
export const tokensCheck = {
  id: 'tokens',
  title: 'Token accounting is honest',
  weight: 15,
  method:
    'Applies invariants to every response: completion ≤ max_tokens, total = prompt + completion, prompt tokens plausible for a known ASCII prompt, stable across repeats, and not an outlier against other vendors.',
  limits: 'A small (< 2×), consistent inflation cannot be told apart from a different tokenizer without a direct-to-provider baseline key.',

  async run(ctx) {
    const records = ctx.records.filter((r) => r.source === 'gateway');
    const { violations, checked, perModel } = evaluateTokens(records);
    if (!checked) return { status: 'skip', summary: 'No successful calls to inspect.' };

    const fails = violations.filter((v) => v.severity === 'fail');
    const status = fails.length ? 'fail' : violations.length ? 'warn' : 'pass';
    return {
      status,
      summary: violations.length
        ? `${violations.length} accounting issue${violations.length === 1 ? '' : 's'} across ${checked} calls: ${violations[0].message}${violations.length > 1 ? ` (+${violations.length - 1} more)` : ''}.`
        : `All ${checked} calls passed every usage invariant.`,
      measured: { calls: checked, violations: violations.length, canaryPromptTokens: perModel },
      details: { violations: violations.slice(0, 12) },
    };
  },
};
