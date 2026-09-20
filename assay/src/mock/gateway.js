import http from 'node:http';
import { formatDecimal, parseDecimal } from '../decimal.js';

/**
 * A fake OpenAI/OpenRouter-compatible gateway that behaves like Orbio is documented to,
 * with switchable faults. It exists so that:
 *   1. `assay demo` works with no key and no network, and
 *   2. every check can be proven to catch the failure it claims to catch.
 *
 * Faults: overcharge, swap, inflate, lag, coarse, nostreamusage, notools, noauthcheck.
 */

export const MOCK_KEY = 'sk-orbio-mock-key-0001';

/** Characters-per-token for ASCII and a weight for non-ASCII characters, per vendor. */
const TOKENIZERS = {
  anthropic: { ascii: 3.9, wide: 1.5 },
  openai: { ascii: 4.1, wide: 1.1 },
  google: { ascii: 4.3, wide: 0.6 },
  deepseek: { ascii: 4.0, wide: 0.9 },
  'x-ai': { ascii: 3.7, wide: 1.3 },
};

/** id, list price per token (input/output), the name providers echo back. */
const CATALOG = [
  ['anthropic/claude-haiku-4.5', '0.0000008', '0.000004', 'claude-haiku-4-5-20251001'],
  ['anthropic/claude-opus-5', '0.000005', '0.000025', 'claude-opus-5-20260601'],
  ['openai/gpt-6-mini', '0.00000015', '0.0000006', 'gpt-6-mini-2026-08-01'],
  ['openai/gpt-6-astra', '0.00001', '0.00005', 'gpt-6-astra-2026-08-01'],
  ['google/gemini-3.8-flash', '0.0000003', '0.00000375', 'gemini-3.8-flash-001'],
  ['deepseek/deepseek-v4-flash', '0.00000014', '0.00000028', 'deepseek-v4-flash-0731'],
  ['x-ai/grok-4.6', '0.000002', '0.000006', 'grok-4.6'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [options]
 * @param {string[]} [options.faults]
 * @param {number} [options.latencyMs]      base response latency
 * @param {number} [options.jitterMs]
 * @param {number} [options.overheadMs]     extra latency, to model a gateway hop
 * @param {number} [options.lagMs]          delay before a charge lands
 * @param {string} [options.balance]        starting balance in USD
 * @param {'per_token'|'per_million'} [options.priceUnit]
 * @param {number} [options.seed]
 * @param {string[]} [options.brokenModels]  ids that answer with a 502, like a provider that is down
 * @param {(call: {model: string, messages: any[], body: any}) => string|null|Promise<string|null>} [options.respond]
 *   custom answer text (null falls back to "ok"); lets tests and the demo simulate models of different skill
 * @returns {Promise<{url:string, baseUrl:string, close:()=>Promise<void>, state:{available:bigint, used:bigint, requests:number}}>}
 */
export async function createMockGateway({
  faults = [], latencyMs = 15, jitterMs = 6, overheadMs = 0, lagMs = 120, balance = '5.000000', priceUnit = 'per_token', seed = 1, brokenModels = [], respond = null,
} = {}) {
  const fault = new Set(faults);
  const state = { available: parseDecimal(balance), used: 0n, requests: 0 };
  let counter = 0;
  let rng = seed >>> 0;
  const jitter = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return (rng / 4294967296) * jitterMs;
  };

  const dp = fault.has('coarse') ? 2 : 6;
  const money = (v) => formatDecimal(v, dp);
  const lagFor = fault.has('lag') ? Math.max(lagMs, 1500) : lagMs;

  const models = CATALOG.map(([id, input, output, echoed]) => ({ id, input, output, echoed, vendor: id.split('/')[0] }));

  const tokenize = (vendor, text) => {
    const t = TOKENIZERS[vendor] ?? TOKENIZERS.openai;
    let ascii = 0;
    let wide = 0;
    for (const ch of text) (ch.codePointAt(0) < 128 ? ascii++ : wide++);
    return Math.max(1, Math.ceil(ascii / t.ascii + wide * t.wide));
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, message) => json(res, status, { error: { message, type: 'invalid_request_error', code: status } });

  const authorized = (req) => fault.has('noauthcheck') || req.headers.authorization === `Bearer ${MOCK_KEY}`;

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve(null);
        }
      });
    });

  const charge = (cost) => {
    setTimeout(() => {
      state.available -= cost;
      state.used += cost;
    }, lagFor);
  };

  const handleChat = async (req, res) => {
    const body = await readBody(req);
    if (!body) return error(res, 400, 'Invalid JSON body');
    const model = models.find((m) => m.id === body.model);
    if (!model) return error(res, 404, `No endpoints found for ${body.model}`);
    if (brokenModels.includes(model.id)) return error(res, 502, `Provider returned error for ${model.id}`);

    state.requests += 1;
    const startBalance = money(state.available);
    const text = (body.messages ?? []).map((m) => String(m.content ?? '')).join('\n');
    const vendorForTokens = fault.has('swap') && model.vendor === 'anthropic' ? 'openai' : model.vendor;
    let promptTokens = tokenize(vendorForTokens, text) + 4 + (body.tools ? 60 : 0);
    if (fault.has('inflate')) promptTokens *= 3;

    const wantsTool = body.tools && body.tool_choice && !fault.has('notools');
    const maxTokens = Number.isInteger(body.max_tokens) ? body.max_tokens : 256;
    const custom = respond && !wantsTool ? await respond({ model: model.id, messages: body.messages ?? [], body }) : null;
    let answer = typeof custom === 'string' ? custom : 'ok';
    let completionTokens = Math.min(wantsTool ? 20 : typeof custom === 'string' ? tokenize(model.vendor, answer) : 2, maxTokens);
    if (typeof custom === 'string' && tokenize(model.vendor, answer) > maxTokens) answer = answer.slice(0, Math.floor(maxTokens * 3.5)); // truncated at the cap, like a real model

    const priceIn = parseDecimal(model.input);
    const priceOut = parseDecimal(model.output);
    const multiplier = fault.has('overcharge') ? 150n : 100n;
    const cost = ((priceIn * BigInt(promptTokens) + priceOut * BigInt(completionTokens)) * multiplier) / 100n;

    await sleep(latencyMs + overheadMs + jitter());

    const echoed = fault.has('swap') && model.vendor === 'anthropic' ? 'gpt-6-mini-2026-08-01' : model.echoed;
    const id = `gen-${(++counter).toString(36)}-${Math.floor(rng % 1e6).toString(36)}`;
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
    const headers = { 'x-orbio-balance': startBalance, 'x-orbio-request-id': id };

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
      const chunk = (delta, finish = null, extra = {}) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: echoed, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(': MOCK PROCESSING\n\n');
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: 'o' }));
      res.write(chunk({ content: 'k' }));
      res.write(chunk({}, 'stop'));
      if (!fault.has('nostreamusage')) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: echoed, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const message = wantsTool
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Lagos' }) } }] }
        : { role: 'assistant', content: answer };
      json(res, 200, {
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: echoed,
        choices: [{ index: 0, message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }],
        usage,
      }, headers);
    }
    charge(cost);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname.replace(/^\/api\/v1/, '');

    if (path === '/models' && req.method === 'GET') {
      const scale = priceUnit === 'per_million' ? (v) => formatDecimal(parseDecimal(v) * 1_000_000n, 6) : (v) => v;
      return json(res, 200, {
        data: models.map((m) => ({
          id: m.id, name: m.id.split('/')[1], context_length: 200000,
          architecture: { output_modalities: ['text'] },
          pricing: { prompt: scale(m.input), completion: scale(m.output) },
        })),
      });
    }

    if (!authorized(req)) return error(res, 401, 'Invalid API key');

    if (path === '/key' && req.method === 'GET') {
      // Like the live gateway: decimal strings plus exact integer micro-USD (omitted under `coarse`).
      const micro = fault.has('coarse') ? {} : { available_micro_usd: String(state.available / 10n ** 12n), used_micro_usd: String(state.used / 10n ** 12n) };
      return json(res, 200, {
        object: 'key',
        balance: { currency: 'USD', available: money(state.available), used: money(state.used), ...micro },
        rate_limit: { requests_per_minute: 120, concurrent: 32 },
      });
    }
    if (path === '/auth/key' && req.method === 'GET') {
      return json(res, 200, { data: { label: 'mock', usage: Number(money(state.used)), limit_remaining: Number(money(state.available)) } });
    }
    if (path === '/chat/completions' && req.method === 'POST') return handleChat(req, res);
    return error(res, 404, `Unknown route ${req.method} ${path}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }),
  };
}
