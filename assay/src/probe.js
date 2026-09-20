import { estimateCallCost } from './catalog.js';
import { tryParseDecimal } from './decimal.js';

/** Fixed, public calibration text (~2000 ASCII characters). Deterministic so token counts are comparable across runs. */
const PARAGRAPH =
  'An assay office tests the purity of precious metals. A sample is weighed, wrapped in lead foil with a little silver, ' +
  'and heated in a cupel until the base metals are absorbed. What remains is weighed again, and the difference tells the ' +
  'assayer how fine the metal was. The result is stamped as a number of parts per thousand, so that anyone can check the ' +
  'claim without having to trust the seller. ';

export const CANARY_PROMPT = `${PARAGRAPH.repeat(5)}\n\nReply with exactly one word: ok.`;
export const CANARY_CHARS = CANARY_PROMPT.length;

/** Text chosen to tokenize very differently across vendors: CJK, emoji, accents, code, digit runs, odd whitespace. */
export const STRESS_PROMPT =
  '日本語のテキスト 🧪🔬⚗️ naïve façade — Ünïcödé; `const x = a?.b ?? 0;` 0xDEADBEEF ' +
  '3.14159265358979323846264338327950288419716939937510   \t\t  zażółć gęślą jaźń ẞ ǅ ﷽ ' +
  'supercalifragilisticexpialidocious antidisestablishmentarianism';

const TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};
export { TOOL as WEATHER_TOOL };

/** Chat content is a string, or (for some providers) an array of typed parts. @param {any} content */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/**
 * @typedef {object} CallRecord
 * @property {string} tag
 * @property {string} model               catalog id requested
 * @property {string|null} respModel      `model` field of the response
 * @property {string|null} respId
 * @property {number} status
 * @property {boolean} ok
 * @property {number|null} promptTokens
 * @property {number|null} completionTokens
 * @property {number|null} totalTokens
 * @property {string|null} finishReason
 * @property {number} latencyMs
 * @property {number} ttfbMs
 * @property {bigint|null} balanceHeader
 * @property {string|null} balanceHeaderRaw
 * @property {Record<string,string>} headers
 * @property {bigint|null} expectedCost   tokens × catalog price
 * @property {bigint|null} reportedCost   `usage.cost` if the gateway reports it
 * @property {number} maxTokens
 * @property {number} promptChars
 * @property {string} source              'gateway' | 'baseline'
 * @property {string} [content]       answer text, only when requested with `keepContent`
 * @property {string} [error]
 */

/**
 * One paid, budget-reserved chat call. Never throws for HTTP/network failures (they become
 * `ok:false` records); does throw BudgetExceededError so callers can stop cleanly.
 *
 * @param {import('./agent.js').AuditContext} ctx
 * @param {import('./catalog.js').CatalogModel} model
 * @param {{prompt?: string, messages?: Array<{role:string, content:string}>, maxTokens: number, tag: string,
 *   client?: import('./client.js').OrbioClient, source?: string, keepContent?: boolean}} opts
 *   Provide `prompt` (one user message) or `messages`. `keepContent` stores the answer text on the record.
 * @returns {Promise<CallRecord>}
 */
export async function probeChat(ctx, model, { prompt, messages, maxTokens, tag, client = ctx.client, source = 'gateway', keepContent = false }) {
  const chat = messages ?? [{ role: 'user', content: prompt ?? '' }];
  const chars = chat.reduce((n, m) => n + m.content.length, 0);
  // Worst case assumes 1 token per 2 characters of prompt, comfortably above real tokenizers for ASCII.
  const worst = estimateCallCost(model, Math.ceil(chars / 2), maxTokens) ?? 0n;
  const settle = ctx.budget.reserve(worst);

  /** @type {CallRecord} */
  const record = {
    tag, model: model.id, respModel: null, respId: null, status: 0, ok: false,
    promptTokens: null, completionTokens: null, totalTokens: null, finishReason: null,
    latencyMs: 0, ttfbMs: 0, balanceHeader: null, balanceHeaderRaw: null, headers: {},
    expectedCost: null, reportedCost: null, maxTokens, promptChars: chars, source,
  };

  let res;
  try {
    res = await client.chat({
      model: model.id,
      messages: chat,
      max_tokens: maxTokens,
      temperature: 0,
    });
  } catch (err) {
    record.error = err.message;
    settle(null);
    ctx.records.push(record);
    return record;
  }

  record.status = res.status;
  record.ok = res.ok && res.json !== null;
  record.latencyMs = res.elapsedMs;
  record.ttfbMs = res.ttfbMs;
  record.headers = res.headers;
  record.balanceHeaderRaw = res.headers['x-orbio-balance'] ?? null;
  record.balanceHeader = tryParseDecimal(record.balanceHeaderRaw);

  if (!record.ok) {
    record.error = `HTTP ${res.status}: ${res.json?.error?.message ?? res.text}`;
    // A 4xx is rejected before any model runs, so it cannot have been billed; a 5xx might have been.
    settle(res.status >= 400 && res.status < 500 ? 0n : null);
    ctx.records.push(record);
    return record;
  }

  const json = res.json;
  const usage = json.usage ?? {};
  record.respModel = typeof json.model === 'string' ? json.model : null;
  record.respId = typeof json.id === 'string' ? json.id : null;
  record.promptTokens = Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : null;
  record.completionTokens = Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : null;
  record.totalTokens = Number.isInteger(usage.total_tokens) ? usage.total_tokens : null;
  record.finishReason = json.choices?.[0]?.finish_reason ?? null;
  record.reportedCost = tryParseDecimal(usage.cost);
  if (keepContent) record.content = messageText(json.choices?.[0]?.message?.content);

  if (record.promptTokens !== null && record.completionTokens !== null && model.promptPrice !== null && model.completionPrice !== null) {
    record.expectedCost = model.promptPrice * BigInt(record.promptTokens) + model.completionPrice * BigInt(record.completionTokens);
  }
  settle(record.expectedCost ?? worst);
  ctx.records.push(record);
  return record;
}
