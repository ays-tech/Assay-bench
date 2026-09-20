import { announceCall } from './probe.js';
import { estimateCallCost } from './catalog.js';
import { redact } from './redact.js';

const SYSTEM =
  'You write a three-sentence factual summary of an API gateway audit for a developer. ' +
  'Use ONLY the JSON provided. Quote every number exactly as it appears. Do not speculate, ' +
  'do not add recommendations, do not mention anything that is not in the JSON. Plain text, no markdown.';

/**
 * The evidence the narrator is allowed to see. Nothing else reaches the model.
 * @param {any} report
 */
export function narrationFacts(report) {
  return {
    fineness: report.score.fineness,
    grade: report.score.grade,
    coverage: report.score.coverage,
    paidCalls: report.spend.calls,
    checks: report.checks.map((c) => ({ id: c.id, status: c.status, finding: c.summary })),
  };
}

/**
 * Every number in the narrative must appear in the facts. This is what stops a fluent model
 * from inventing a figure that then gets published next to the real ones.
 *
 * @param {string} text @param {unknown} facts
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateNarrative(text, facts) {
  const allowed = new Set((JSON.stringify(facts).match(/\d+(?:\.\d+)?/g) ?? []).map(normalizeNumber));
  const used = text.match(/\d+(?:\.\d+)?/g) ?? [];
  for (const n of used) {
    if (!allowed.has(normalizeNumber(n))) return { ok: false, reason: `number ${n} is not in the evidence` };
  }
  if (text.trim().length < 20) return { ok: false, reason: 'too short' };
  if (text.length > 900) return { ok: false, reason: 'too long' };
  return { ok: true };
}

/** @param {string} n */
const normalizeNumber = (n) => String(Number(n));

/**
 * Ask a cheap model to narrate the report, through the very gateway being audited.
 * Returns null (and the dashboard falls back to the deterministic headline) on any failure.
 *
 * @param {import('./agent.js').AuditContext} ctx
 * @param {any} report
 * @param {string|true} choice explicit model id, or `true` for the cheapest audited model
 * @returns {Promise<{model:string, text:string}|null>}
 */
export async function narrate(ctx, report, choice) {
  const model = typeof choice === 'string'
    ? ctx.catalog?.models.find((m) => m.id === choice)
    : [...ctx.models].sort((a, b) => Number((a.completionPrice ?? 0n) - (b.completionPrice ?? 0n)))[0];
  if (!model) {
    ctx.log(`narrate: model ${choice} not found in catalog`);
    return null;
  }

  const facts = narrationFacts(report);
  let settle;
  try {
    settle = ctx.budget.reserve(estimateCallCost(model, 900, 220) ?? 0n);
  } catch {
    return null;
  }
  try {
    const res = await ctx.client.chat({
      model: model.id,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(facts) },
      ],
      max_tokens: 220,
      temperature: 0.2,
    });
    settle(null);
    announceCall(ctx, model, { tag: 'narrate', ok: res.ok, status: res.status, usage: res.json?.usage, latencyMs: Math.round(res.elapsedMs ?? 0), error: res.ok ? null : `HTTP ${res.status}` });
    const text = res.json?.choices?.[0]?.message?.content;
    if (!res.ok || typeof text !== 'string') return null;
    const verdict = validateNarrative(text, facts);
    if (!verdict.ok) {
      ctx.log(`narrate: discarded (${verdict.reason})`);
      return null;
    }
    return { model: model.id, text: text.trim() };
  } catch (err) {
    settle(null);
    ctx.log(`narrate: ${redact(err.message, [ctx.config.apiKey])}`);
    return null;
  }
}
