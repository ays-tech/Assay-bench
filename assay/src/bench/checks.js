import { extractJson, validateSchema } from './schema.js';

/**
 * @typedef {object} Expect
 * @property {boolean} [json]            response must contain valid JSON
 * @property {object} [schema]           JSON-Schema subset the JSON must satisfy
 * @property {Record<string, any>} [fields]  fields the JSON must contain (strings compare case-insensitively)
 * @property {string} [equals]           whole response must equal this (trimmed, case-insensitive)
 * @property {string[]} [contains]       every string must appear (case-insensitive)
 * @property {string[]} [notContains]    none may appear
 * @property {string} [regex]            must match
 * @property {number} [maxChars]         response length limit
 */

export const CHECK_KEYS = ['json', 'schema', 'fields', 'equals', 'contains', 'notContains', 'regex', 'maxChars'];

/** Recursive subset match. Strings are trimmed and case-folded; arrays must match element-wise. */
export function deepMatch(actual, expected) {
  if (typeof expected === 'string') return typeof actual === 'string' && actual.trim().toLowerCase() === expected.trim().toLowerCase();
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => deepMatch(actual[i], e));
  if (expected && typeof expected === 'object') {
    return actual && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([k, v]) => k in actual && deepMatch(actual[k], v));
  }
  return actual === expected;
}

/**
 * Run every deterministic check the prompt declares. Pure.
 * @param {Expect|undefined} expect
 * @param {string|null} text the model's answer (null when the call failed)
 * @returns {{hasChecks: boolean, pass: boolean, results: Array<{name: string, pass: boolean, detail: string}>}}
 */
export function runChecks(expect, text) {
  const results = [];
  const add = (name, pass, detail = '') => results.push({ name, pass, detail });
  const declared = expect ? CHECK_KEYS.filter((k) => expect[k] !== undefined) : [];
  if (!declared.length) return { hasChecks: false, pass: true, results };

  const answer = typeof text === 'string' ? text : '';
  const lower = answer.toLowerCase();
  if (typeof text !== 'string') add('response', false, 'no response (the call failed)');

  const needsJson = declared.includes('json') || declared.includes('schema') || declared.includes('fields');
  const parsed = needsJson ? extractJson(answer) : null;
  if (parsed) add('json', parsed.ok, parsed.ok ? 'valid JSON' : parsed.error);

  if (expect?.schema) {
    const errors = parsed?.ok ? validateSchema(parsed.value, expect.schema) : ['no JSON to validate'];
    add('schema', errors.length === 0, errors.slice(0, 3).join('; ') || 'matches schema');
  }
  if (expect?.fields) {
    const ok = Boolean(parsed?.ok) && deepMatch(parsed.value, expect.fields);
    add('fields', ok, ok ? 'fields match' : parsed?.ok ? `expected ${JSON.stringify(expect.fields)}, got ${clip(JSON.stringify(parsed.value))}` : 'no JSON to compare');
  }
  if (expect?.equals !== undefined) {
    const ok = answer.trim().toLowerCase() === String(expect.equals).trim().toLowerCase();
    add('equals', ok, ok ? 'exact match' : `expected "${expect.equals}", got "${clip(answer.trim())}"`);
  }
  for (const needle of expect?.contains ?? []) add('contains', lower.includes(String(needle).toLowerCase()), `"${needle}"`);
  for (const needle of expect?.notContains ?? []) add('notContains', !lower.includes(String(needle).toLowerCase()), `"${needle}"`);
  if (expect?.regex !== undefined) {
    let ok = false;
    try {
      ok = new RegExp(expect.regex, 'i').test(answer);
    } catch { /* invalid pattern is rejected at dataset load; treat as failure here */ }
    add('regex', ok, `/${expect.regex}/`);
  }
  if (expect?.maxChars !== undefined) add('maxChars', answer.length <= expect.maxChars, `${answer.length} of ${expect.maxChars} characters`);

  return { hasChecks: true, pass: results.every((r) => r.pass), results };
}

/** @param {string} s @param {number} [n] */
function clip(s, n = 140) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
