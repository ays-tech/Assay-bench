import { BudgetExceededError } from '../budget.js';
import { normalizeCatalog, selectAuditModels } from '../catalog.js';
import { clip } from '../redact.js';
import { probeChat } from '../probe.js';

const AUDIT_MODEL_COUNT = 3;
const PREFLIGHT_PROMPT = 'Reply with the single word: ok';

/**
 * Prove each candidate can actually answer before the audit builds on it, and substitute the
 * next candidate when one cannot. A verdict built on models that never responded would be
 * an overclaim, which is exactly what this tool exists to catch.
 *
 * @param {import('../agent.js').AuditContext} ctx
 * @param {import('../catalog.js').CatalogModel[]} queue candidates in order of preference
 * @param {number} want how many working models to stop at
 */
async function preflight(ctx, queue, want) {
  const working = [];
  const skipped = [];
  const attempts = Math.min(queue.length, want + 5);
  for (const model of queue.slice(0, attempts)) {
    if (working.length >= want) break;
    const rec = await probeChat(ctx, model, { prompt: PREFLIGHT_PROMPT, maxTokens: 8, tag: 'preflight' });
    if (rec.ok) working.push(model);
    else skipped.push({ id: model.id, error: clip(rec.error ?? 'no response', 160) });
  }
  return { working, skipped };
}

/** @type {import('./index.js').Check} */
export const catalogCheck = {
  id: 'catalog',
  title: 'Model catalog and audit plan',
  weight: 5,
  method:
    'Fetches GET /models, verifies ids are unique and prices are finite and non-negative, detects the price unit, then selects the cheapest viable model from each of several vendors. Every chosen model must answer a tiny preflight call; ones that cannot are skipped, reported, and replaced.',
  limits: 'Cannot confirm catalog prices equal the providers\' list prices; the billing check verifies what you are actually charged.',

  async run(ctx) {
    const res = await ctx.client.get('/models');
    if (!res.ok || !res.json) {
      return { status: 'fail', summary: `GET /models returned HTTP ${res.status}.`, measured: { status: res.status }, details: { body: res.text } };
    }
    const catalog = normalizeCatalog(res.json, { priceUnit: ctx.config.priceUnit });
    if (!catalog.models.length) {
      return { status: 'fail', summary: 'Catalog is empty or has an unexpected shape.', details: { issues: catalog.issues, body: res.text } };
    }
    ctx.catalog = catalog;

    const explicit = ctx.config.models.length > 0;
    const { selected, alternates, missing } = selectAuditModels(catalog.models, { explicit: ctx.config.models, count: AUDIT_MODEL_COUNT });

    const issues = [...catalog.issues];
    for (const id of missing) issues.push(`Requested model not found or unpriced: ${id}`);

    ctx.models = [];
    ctx.skippedModels = [];
    if (selected.length) {
      const { working, skipped } = await preflight(ctx, [...selected, ...alternates], explicit ? selected.length : AUDIT_MODEL_COUNT);
      ctx.models = working;
      ctx.skippedModels = skipped;
    }
    for (const s of ctx.skippedModels) issues.push(`${s.id} did not answer a preflight call and was skipped: ${s.error}`);

    const vendors = new Set(ctx.models.map((m) => m.vendor));
    const status = !ctx.models.length ? 'warn' : issues.length ? 'warn' : 'pass';
    if (!ctx.models.length) issues.push('No model answered a preflight call, so nothing could be audited.');

    return {
      status,
      summary:
        `${catalog.models.length} models (${catalog.unpriced} unpriced), prices in ${catalog.priceUnit === 'per_million' ? 'USD per million tokens' : 'USD per token'}. ` +
        (ctx.models.length
          ? `Auditing ${ctx.models.map((m) => m.id).join(', ')} across ${vendors.size} vendor${vendors.size === 1 ? '' : 's'}.`
          : 'Nothing could be audited.') +
        (ctx.skippedModels.length ? ` Skipped ${ctx.skippedModels.length} that failed preflight (${ctx.skippedModels.map((s) => s.id).join(', ')}).` : ''),
      measured: { models: catalog.models.length, unpriced: catalog.unpriced, priceUnit: catalog.priceUnit, selected: ctx.models.map((m) => m.id), skipped: ctx.skippedModels.length },
      details: { issues: issues.slice(0, 10), issueCount: issues.length, skipped: ctx.skippedModels },
    };
  },
};
