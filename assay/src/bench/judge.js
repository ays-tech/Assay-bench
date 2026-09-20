import { UNSUITABLE_ID, estimateCallCost } from '../catalog.js';

/** Marker the mock gateway (and tests) use to recognise judge calls. */
export const JUDGE_MARKER = 'strict evaluator';

export const JUDGE_SYSTEM =
  `You are a ${JUDGE_MARKER} comparing two answers to the same task. ` +
  'Judge only against the rubric. Ignore length, style, and the order the answers appear in. ' +
  'Reply with ONLY a JSON object: {"winner":"A"} or {"winner":"B"} or {"winner":"tie"}.';

/**
 * @param {{task: string, rubric: string, a: string, b: string}} p
 * @returns {Array<{role:string, content:string}>}
 */
export function judgeMessages({ task, rubric, a, b }) {
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: `Task:\n${task}\n\nRubric:\n${rubric}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}\n\nWhich answer better satisfies the rubric?` },
  ];
}

/**
 * @param {string|null} text
 * @returns {'A'|'B'|'tie'|null} null when the judge did not follow the format
 */
export function parseVerdict(text) {
  if (typeof text !== 'string') return null;
  const json = /\{[^{}]*\}/.exec(text);
  if (json) {
    try {
      const w = String(JSON.parse(json[0]).winner ?? '').trim().toLowerCase();
      if (w === 'a') return 'A';
      if (w === 'b') return 'B';
      if (w === 'tie' || w === 'draw' || w === 'equal') return 'tie';
    } catch { /* fall through to the loose match */ }
  }
  const loose = /\bwinner\b\W{0,4}(a|b|tie)\b/i.exec(text);
  if (loose) return loose[1].toLowerCase() === 'tie' ? 'tie' : /** @type {'A'|'B'} */ (loose[1].toUpperCase());
  return null;
}

/**
 * The judge sees each pair twice with the positions swapped, so a judge that simply prefers
 * whichever answer comes first cancels itself out instead of tilting the result.
 *
 * @param {'A'|'B'|'tie'|null} referenceFirst  verdict when A = current model, B = candidate
 * @param {'A'|'B'|'tie'|null} candidateFirst  verdict when A = candidate, B = current model
 * @returns {{score: number|null, valid: number, positionBiased: boolean}}
 *   score is the candidate's result against the current model: 1 win, 0.5 tie, 0 loss (averaged over valid verdicts)
 */
export function combineVerdicts(referenceFirst, candidateFirst) {
  const one = referenceFirst === 'B' ? 1 : referenceFirst === 'A' ? 0 : referenceFirst === 'tie' ? 0.5 : null;
  const two = candidateFirst === 'A' ? 1 : candidateFirst === 'B' ? 0 : candidateFirst === 'tie' ? 0.5 : null;
  const valid = [one, two].filter((v) => v !== null);
  if (!valid.length) return { score: null, valid: 0, positionBiased: false };
  // Picking the same *position* both times (A,A or B,B) is the signature of position bias.
  const positionBiased = referenceFirst !== null && referenceFirst === candidateFirst && referenceFirst !== 'tie';
  return { score: valid.reduce((a, b) => a + b, 0) / valid.length, valid: valid.length, positionBiased };
}

const JUDGE_VENDORS = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'mistralai'];

/**
 * Pick a judge that is neither the current model's vendor nor the candidate's, so no model
 * grades its own family. Mid-priced within a vendor: cheap enough to run many times, capable
 * enough to tell answers apart. An explicit `--judge` always wins (and is flagged if conflicted).
 *
 * @param {import('../catalog.js').CatalogModel[]} models
 * @param {{avoid: Set<string>, exclude?: Set<string>}} opts
 * @returns {import('../catalog.js').CatalogModel[]} candidates in order of preference
 */
export function judgeCandidates(models, { avoid, exclude = new Set() }) {
  const usable = models.filter(
    (m) => m.promptPrice !== null && m.completionPrice !== null && m.completionPrice > 0n && !UNSUITABLE_ID.test(m.id) && !exclude.has(m.id) &&
      (m.contextLength === null || m.contextLength >= 16000) && (m.outputModalities === null || m.outputModalities.includes('text')),
  );
  const cost = (m) => Number(estimateCallCost(m, 600, 30) ?? 0n);
  const picks = [];
  for (const vendor of JUDGE_VENDORS) {
    if (avoid.has(vendor)) continue;
    const list = usable.filter((m) => m.vendor === vendor).sort((a, b) => cost(a) - cost(b));
    if (list.length) picks.push(list[Math.floor((list.length - 1) / 2)]);
  }
  return picks;
}
