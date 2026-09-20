import { STRESS_PROMPT, probeChat } from '../probe.js';
import { BudgetExceededError } from '../budget.js';

const VENDOR_MARKERS = {
  anthropic: /claude/,
  openai: /gpt|chatgpt|(^|-)o[134](-|$)/,
  google: /gemini|gemma|palm/,
  deepseek: /deepseek/,
  'x-ai': /grok/,
  moonshotai: /kimi/,
  'meta-llama': /llama/,
  mistralai: /mistral|mixtral|ministral|codestral|pixtral/,
  qwen: /qwen|qwq/,
};

/**
 * Lowercase, drop vendor prefix, `:variant`, and trailing date stamps so that
 * `anthropic/claude-sonnet-5` and `claude-sonnet-5-20260601` compare equal.
 * @param {string} name
 */
export function normalizeModelName(name) {
  return name
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/:.+$/, '')
    .replace(/@.+$/, '')
    .replace(/[-_.]?(20\d{2})[-_]?(\d{2})[-_]?(\d{2})$/, '')
    .replace(/[._]/g, '-') // claude-haiku-4.5 and claude-haiku-4-5 are the same model
    .replace(/-+$/, '');
}

/**
 * Compare the model the caller asked for with the model the response claims.
 *
 * `mismatch` is reserved for the case that matters: the response names a recognisably
 * DIFFERENT vendor's model. An unfamiliar name is `unknown`, never an accusation.
 *
 * @param {string} requested catalog id, e.g. "anthropic/claude-sonnet-5"
 * @param {string|null} returned `model` field of the response
 * @returns {'match'|'same-family'|'mismatch'|'unknown'}
 */
export function declaredMatch(requested, returned) {
  if (!returned) return 'unknown';
  const a = normalizeModelName(requested);
  const b = normalizeModelName(returned);
  if (a === b || a.startsWith(b) || b.startsWith(a)) return 'match';

  const vendor = requested.split('/')[0]?.toLowerCase();
  const own = VENDOR_MARKERS[/** @type {keyof typeof VENDOR_MARKERS} */ (vendor)];
  if (own?.test(b)) return 'same-family';
  const otherVendor = Object.entries(VENDOR_MARKERS).some(([v, re]) => v !== vendor && re.test(b));
  return otherVendor ? 'mismatch' : 'unknown';
}

/**
 * Pure: judge identity evidence.
 * @param {{records: import('../probe.js').CallRecord[], fingerprints: Record<string, number[]>, baseline: Record<string, number>}} evidence
 */
export function evaluateIdentity({ records, fingerprints, baseline }) {
  const ok = records.filter((r) => r.ok);
  /** @type {Record<string, {match:number, sameFamily:number, mismatch:number, unknown:number, returned:Set<string>}>} */
  const declared = {};
  for (const r of ok) {
    const d = (declared[r.model] ??= { match: 0, sameFamily: 0, mismatch: 0, unknown: 0, returned: new Set() });
    const verdict = declaredMatch(r.model, r.respModel);
    if (r.respModel) d.returned.add(r.respModel);
    if (verdict === 'match') d.match++;
    else if (verdict === 'same-family') d.sameFamily++;
    else if (verdict === 'mismatch') d.mismatch++;
    else d.unknown++;
  }

  /** Mislabelled: repeated mismatches for one model, or every response for a model. */
  const total = (d) => d.match + d.sameFamily + d.mismatch + d.unknown;
  const mislabelled = Object.entries(declared).filter(([, d]) => d.mismatch >= 2 || (d.mismatch > 0 && d.mismatch === total(d)));
  const mislabelledNames = new Set(mislabelled.map(([m]) => m));
  const singleMismatch = Object.entries(declared).filter(([m, d]) => d.mismatch === 1 && !mislabelledNames.has(m));

  const ids = ok.map((r) => r.respId).filter(Boolean);
  const duplicateIds = ids.length - new Set(ids).size;

  const unstable = Object.entries(fingerprints).filter(([, t]) => t.length >= 2 && Math.max(...t) - Math.min(...t) > 1).map(([m]) => m);

  // Different vendors should tokenize a Unicode/code stress prompt differently.
  const perVendor = new Map();
  for (const [model, t] of Object.entries(fingerprints)) if (t.length) perVendor.set(model.split('/')[0], t[0]);
  const distinctCounts = new Set(perVendor.values());
  const indistinct = perVendor.size >= 2 && distinctCounts.size === 1;

  const baselineMismatch = Object.entries(baseline)
    .filter(([model, tokens]) => fingerprints[model]?.length && Math.abs(fingerprints[model][0] - tokens) > 2)
    .map(([model, tokens]) => ({ model, gateway: fingerprints[model][0], direct: tokens }));
  const baselineCompared = Object.keys(baseline).filter((m) => fingerprints[m]?.length).length;

  return {
    declared: Object.fromEntries(Object.entries(declared).map(([m, d]) => [m, { ...d, returned: [...d.returned] }])),
    mislabelled: mislabelled.map(([m]) => m),
    singleMismatch: singleMismatch.map(([m]) => m),
    duplicateIds,
    unstable,
    indistinct,
    fingerprints,
    baselineMismatch,
    baselineCompared,
    checked: ok.length,
  };
}

/** @type {import('./index.js').Check} */
export const identityCheck = {
  id: 'identity',
  title: 'The model you ask for answers',
  weight: 20,
  method:
    'Compares the returned model name with the requested id and vendor family, checks response ids are unique, and sends a Unicode/code stress prompt whose prompt-token count acts as a tokenizer fingerprint: it must be stable per model and differ across vendors. ' +
    'With a baseline key it must equal the count from the provider directly.',
  limits: 'Detects mislabelling and gross substitution. It cannot prove which weights ran, and a gateway that fakes both the name and the token count would pass.',

  async run(ctx) {
    if (!ctx.models.length) return { status: 'skip', summary: 'No models selected to audit.' };

    /** @type {Record<string, number[]>} */
    const fingerprints = {};
    /** @type {Record<string, number>} */
    const baseline = {};
    try {
      for (const model of ctx.models) {
        for (let i = 0; i < 2; i++) {
          const rec = await probeChat(ctx, model, { prompt: STRESS_PROMPT, maxTokens: 1, tag: 'fingerprint' });
          if (rec.ok && rec.promptTokens !== null) (fingerprints[model.id] ??= []).push(rec.promptTokens);
        }
        if (ctx.baselineClient) {
          const rec = await probeChat(ctx, model, { prompt: STRESS_PROMPT, maxTokens: 1, tag: 'baseline-fingerprint', client: ctx.baselineClient, source: 'baseline' });
          if (rec.ok && rec.promptTokens !== null) baseline[model.id] = rec.promptTokens;
        }
      }
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
    }

    const gatewayRecords = ctx.records.filter((r) => r.source === 'gateway');
    const ev = evaluateIdentity({ records: gatewayRecords, fingerprints, baseline });
    if (!ev.checked) return { status: 'skip', summary: 'No successful calls to inspect.' };

    /** @type {string[]} */
    const findings = [];
    let status = /** @type {'pass'|'warn'|'fail'} */ ('pass');
    if (ev.mislabelled.length) {
      status = 'fail';
      findings.push(`${ev.mislabelled.join(', ')} answered as a different model (${ev.mislabelled.map((m) => ev.declared[m].returned.join('/')).join('; ')})`);
    }
    if (ev.baselineMismatch.length) {
      status = 'fail';
      findings.push(`tokenizer fingerprint differs from the direct provider for ${ev.baselineMismatch.map((b) => `${b.model} (${b.gateway} vs ${b.direct})`).join(', ')}`);
    }
    if (status !== 'fail') {
      if (ev.singleMismatch.length) findings.push(`one response for ${ev.singleMismatch.join(', ')} carried a different model name`);
      if (ev.duplicateIds > 0) findings.push(`${ev.duplicateIds} repeated response id${ev.duplicateIds === 1 ? '' : 's'} (cached or replayed responses?)`);
      if (ev.unstable.length) findings.push(`unstable tokenizer fingerprint for ${ev.unstable.join(', ')}`);
      if (ev.indistinct) findings.push('every vendor produced the same token count, so fingerprints cannot tell them apart');
      if (findings.length) status = 'warn';
    }

    // Count only vendors that actually answered; a vendor that never responded proves nothing.
    const responding = new Set(gatewayRecords.filter((r) => r.ok).map((r) => r.model.split('/')[0]));
    const vendors = responding.size;
    if (status === 'pass' && vendors < 2) {
      findings.push(`only ${vendors} vendor responded, so fingerprint distinctness across vendors was not tested`);
      status = 'warn';
    }
    return {
      status,
      summary: findings.length
        ? `${findings[0]}${findings.length > 1 ? ` (+${findings.length - 1} more)` : ''}.`
        : `${ev.checked} responses named the requested model across ${vendors} vendors; fingerprints stable and distinct${ev.baselineCompared ? `; matched the direct provider for ${ev.baselineCompared} model${ev.baselineCompared === 1 ? '' : 's'}` : ''}.`,
      measured: { responses: ev.checked, fingerprints: ev.fingerprints, baselineCompared: ev.baselineCompared },
      details: { declared: ev.declared, duplicateIds: ev.duplicateIds, baselineMismatch: ev.baselineMismatch },
    };
  },
};
