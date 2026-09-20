import { readFileSync, statSync } from 'node:fs';
import { CHECK_KEYS } from './checks.js';

const MAX_BYTES = 5_000_000;
const MAX_PROMPT_CHARS = 30_000;

export class DatasetError extends Error {
  /** @param {string} message @param {string[]} [problems] */
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n  - ${problems.join('\n  - ')}` : message);
    this.name = 'DatasetError';
    this.problems = problems;
  }
}

/**
 * @typedef {object} BenchItem
 * @property {string} id
 * @property {Array<{role: string, content: string}>} messages
 * @property {import('./checks.js').Expect} [expect]
 * @property {{rubric: string}|null} judge   fuzzy quality, graded by a model against the current model's answer
 * @property {number} [maxTokens]
 */

/**
 * Parse a JSONL benchmark file. One JSON object per line:
 *
 *   {"id":"t1","system":"…","prompt":"…","expect":{"fields":{"category":"billing"}}}
 *   {"messages":[{"role":"user","content":"…"}],"judge":{"rubric":"Polite, accurate, under 3 sentences"}}
 *
 * Every problem is collected, not just the first, so a bad file is fixed in one pass.
 * @param {string} text
 * @returns {BenchItem[]}
 */
export function parseDataset(text) {
  /** @type {BenchItem[]} */
  const items = [];
  const problems = [];
  const seen = new Set();

  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const at = `line ${index + 1}`;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      problems.push(`${at}: not valid JSON`);
      return;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`${at}: each line must be a JSON object`);
      return;
    }

    const id = String(row.id ?? `p${items.length + 1}`);
    if (seen.has(id)) problems.push(`${at}: duplicate id "${id}"`);
    seen.add(id);

    /** @type {Array<{role:string, content:string}>} */
    let messages;
    if (Array.isArray(row.messages) && row.messages.length) {
      messages = row.messages.map((m) => ({ role: String(m?.role ?? ''), content: String(m?.content ?? '') }));
      if (messages.some((m) => !['system', 'user', 'assistant'].includes(m.role) || !m.content)) problems.push(`${at}: messages need a role (system/user/assistant) and content`);
    } else if (typeof row.prompt === 'string' && row.prompt.trim()) {
      messages = [...(typeof row.system === 'string' && row.system ? [{ role: 'system', content: row.system }] : []), { role: 'user', content: row.prompt }];
    } else {
      problems.push(`${at}: needs "prompt" (string) or "messages" (array)`);
      return;
    }
    if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_PROMPT_CHARS) problems.push(`${at}: prompt is longer than ${MAX_PROMPT_CHARS} characters`);

    const expect = row.expect && typeof row.expect === 'object' ? row.expect : undefined;
    const declared = expect ? CHECK_KEYS.filter((k) => expect[k] !== undefined) : [];
    const unknown = expect ? Object.keys(expect).filter((k) => !CHECK_KEYS.includes(k)) : [];
    if (unknown.length) problems.push(`${at}: unknown check ${unknown.map((k) => `"${k}"`).join(', ')} (known: ${CHECK_KEYS.join(', ')})`);
    if (expect?.regex !== undefined) {
      try { new RegExp(expect.regex); } catch { problems.push(`${at}: "regex" is not a valid pattern`); }
    }

    /** @type {{rubric: string}|null} */
    let judge = null;
    if (row.judge === true) judge = { rubric: 'The answer is accurate, complete, and clear.' };
    else if (typeof row.judge === 'string' && row.judge.trim()) judge = { rubric: row.judge.trim() };
    else if (row.judge && typeof row.judge === 'object' && typeof row.judge.rubric === 'string') judge = { rubric: row.judge.rubric };

    if (!declared.length && !judge) {
      problems.push(`${at}: needs "expect" with a check (${CHECK_KEYS.join(', ')}) or a "judge"; otherwise there is nothing to score`);
      return;
    }
    items.push({ id, messages, expect: declared.length ? expect : undefined, judge, maxTokens: Number.isInteger(row.max_tokens) ? row.max_tokens : undefined });
  });

  if (problems.length) throw new DatasetError(`Dataset has ${problems.length} problem${problems.length === 1 ? '' : 's'}:`, problems.slice(0, 12));
  if (!items.length) throw new DatasetError('Dataset is empty.');
  return items;
}

/** @param {string} path */
export function loadDataset(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    throw new DatasetError(`Cannot read dataset "${path}".`);
  }
  if (size > MAX_BYTES) throw new DatasetError(`Dataset is larger than ${MAX_BYTES / 1e6} MB.`);
  return parseDataset(readFileSync(path, 'utf8'));
}
