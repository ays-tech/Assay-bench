import { tryParseDecimal, ONE } from './decimal.js';
import { median } from './stats.js';

/**
 * @typedef {object} CatalogModel
 * @property {string} id
 * @property {string} name
 * @property {string} vendor
 * @property {number|null} contextLength
 * @property {bigint|null} promptPrice       USD per token, scaled decimal
 * @property {bigint|null} completionPrice   USD per token, scaled decimal
 * @property {string[]|null} outputModalities
 */

/**
 * @typedef {object} NormalizedCatalog
 * @property {CatalogModel[]} models
 * @property {'per_token'|'per_million'} priceUnit  unit the gateway reported prices in
 * @property {string[]} issues                       structural problems worth surfacing
 * @property {number} unpriced                        entries without a usable price
 */

/** @param {string} id */
export function vendorOf(id) {
  const i = id.indexOf('/');
  return i > 0 ? id.slice(0, i).toLowerCase() : 'unknown';
}

/**
 * Normalise an OpenRouter-shaped `/models` payload.
 * Prices are converted to USD per token regardless of the unit the gateway uses.
 *
 * @param {any} raw
 * @param {{priceUnit?: 'auto'|'per_token'|'per_million'}} [opts]
 * @returns {NormalizedCatalog}
 */
export function normalizeCatalog(raw, { priceUnit = 'auto' } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : null;
  if (!list) return { models: [], priceUnit: 'per_token', issues: ['Response has no model list (expected `data: [...]`)'], unpriced: 0 };

  /** @type {string[]} */
  const issues = [];
  const seen = new Set();
  const rows = [];
  let unpriced = 0;

  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      issues.push('Entry without a string `id`');
      continue;
    }
    if (seen.has(entry.id)) issues.push(`Duplicate id: ${entry.id}`);
    seen.add(entry.id);

    const p = entry.pricing ?? {};
    const promptRaw = p.prompt ?? p.input;
    const completionRaw = p.completion ?? p.output;
    let prompt = tryParseDecimal(promptRaw);
    let completion = tryParseDecimal(completionRaw);
    if (promptRaw != null && prompt === null) issues.push(`Unparseable prompt price for ${entry.id}`);
    if (completionRaw != null && completion === null) issues.push(`Unparseable completion price for ${entry.id}`);
    // Negative prices are OpenRouter's marker for dynamic pricing (e.g. routers): treat as unpriced.
    if (prompt !== null && prompt < 0n) prompt = null;
    if (completion !== null && completion < 0n) completion = null;
    if (prompt === null || completion === null) unpriced += 1;

    const modalities = entry.architecture?.output_modalities;
    rows.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      vendor: vendorOf(entry.id),
      contextLength: Number.isFinite(entry.context_length) ? entry.context_length : null,
      promptPrice: prompt,
      completionPrice: completion,
      outputModalities: Array.isArray(modalities) ? modalities.map(String) : null,
    });
  }

  const unit = priceUnit === 'auto' ? detectPriceUnit(rows) : priceUnit;
  const models = unit === 'per_million'
    ? rows.map((m) => ({
        ...m,
        promptPrice: m.promptPrice === null ? null : m.promptPrice / 1_000_000n,
        completionPrice: m.completionPrice === null ? null : m.completionPrice / 1_000_000n,
      }))
    : rows;

  return { models, priceUnit: unit, issues, unpriced };
}

/**
 * Per-token prices are tiny (≈1e-7); per-million prices are ≈0.1–100. The median non-zero
 * completion price separates them by orders of magnitude.
 * @param {Array<{completionPrice: bigint|null}>} rows
 * @returns {'per_token'|'per_million'}
 */
export function detectPriceUnit(rows) {
  const values = rows.filter((m) => m.completionPrice !== null && m.completionPrice > 0n).map((m) => Number(m.completionPrice) / Number(ONE));
  if (!values.length) return 'per_token';
  return median(values) > 0.001 ? 'per_million' : 'per_token';
}

/**
 * @param {CatalogModel[]} models @param {string} id
 */
export function findModel(models, id) {
  return models.find((m) => m.id === id) ?? models.find((m) => m.id.toLowerCase() === id.toLowerCase()) ?? null;
}

export const UNSUITABLE_ID = /(thinking|reasoner|reasoning|deep-research|-r1\b|(^|[/-])o[134](-|$)|-search|audio|image|tts|embed|moderation|whisper|:)/i; // any `:variant` suffix (free, batch, extended, …) is a different endpoint, not the model itself
export const PREFERRED_VENDORS = ['anthropic', 'openai', 'google', 'deepseek', 'x-ai', 'mistralai', 'meta-llama', 'qwen', 'moonshotai'];

/** Rough worst-case USD cost of one call with `promptTokens` in and `maxTokens` out. */
export function estimateCallCost(model, promptTokens, maxTokens) {
  if (model.promptPrice === null || model.completionPrice === null) return null;
  return model.promptPrice * BigInt(promptTokens) + model.completionPrice * BigInt(maxTokens);
}

/**
 * Choose models to audit: cheapest viable per vendor, spread across vendors so identity
 * fingerprints can be compared. Explicit ids are honoured (and reported when missing).
 *
 * `alternates` are the next-best candidates in the same order of preference. The agent
 * substitutes them when a chosen model fails its preflight call.
 *
 * @param {CatalogModel[]} models
 * @param {{explicit?: string[], count?: number}} [opts]
 * @returns {{selected: CatalogModel[], alternates: CatalogModel[], missing: string[]}}
 */
export function selectAuditModels(models, { explicit = [], count = 3 } = {}) {
  if (explicit.length) {
    const selected = [];
    const missing = [];
    for (const id of explicit) {
      const m = findModel(models, id);
      if (m && m.promptPrice !== null && m.completionPrice !== null) selected.push(m);
      else missing.push(id);
    }
    return { selected, alternates: [], missing };
  }

  const usable = models.filter(
    (m) =>
      m.promptPrice !== null &&
      m.completionPrice !== null &&
      m.completionPrice > 0n &&
      (m.contextLength === null || m.contextLength >= 8192) &&
      (m.outputModalities === null || m.outputModalities.includes('text')) &&
      !UNSUITABLE_ID.test(m.id),
  );

  const cost = (m) => estimateCallCost(m, 450, 16) ?? 0n;
  /** @type {Map<string, CatalogModel[]>} */
  const byVendor = new Map();
  for (const m of usable) byVendor.set(m.vendor, [...(byVendor.get(m.vendor) ?? []), m]);
  for (const list of byVendor.values()) list.sort((a, b) => Number(cost(a) - cost(b)));

  const rank = (vendor) => {
    const i = PREFERRED_VENDORS.indexOf(vendor);
    return i === -1 ? PREFERRED_VENDORS.length : i;
  };
  const vendors = [...byVendor.keys()].sort((a, b) => rank(a) - rank(b) || Number(cost(byVendor.get(a)[0]) - cost(byVendor.get(b)[0])));

  // Round-robin by depth: every vendor's cheapest first, then every vendor's second cheapest, …
  const ranked = [];
  for (let depth = 0; depth < 3; depth++) {
    for (const v of vendors) {
      const m = byVendor.get(v)?.[depth];
      if (m) ranked.push(m);
    }
  }
  return { selected: ranked.slice(0, count), alternates: ranked.slice(count), missing: [] };
}
