import { BudgetExceededError } from '../budget.js';
import { estimateCallCost } from '../catalog.js';
import { announceCall, WEATHER_TOOL } from '../probe.js';

/**
 * Pure: judge a streamed chat completion summary.
 * @param {Awaited<ReturnType<import('../client.js').OrbioClient['chatStream']>>} s
 * @returns {{severity:'pass'|'warn'|'fail', problems:string[]}}
 */
export function evaluateStream(s) {
  if (s.status !== 200) return { severity: 'fail', problems: [`HTTP ${s.status}${s.errorText ? `: ${s.errorText}` : ''}`] };
  if (!s.chunks.length) return { severity: 'fail', problems: ['no data chunks received'] };
  /** @type {string[]} */
  const problems = [];
  if (!s.chunks.some((c) => Array.isArray(c.choices))) problems.push('chunks have no choices[] array');
  if (s.malformed) problems.push(`${s.malformed} malformed chunk${s.malformed === 1 ? '' : 's'}`);
  if (!s.doneSeen) problems.push('stream did not end with [DONE]');
  if (!s.usage) problems.push('no usage in the final chunk, so streamed calls cannot be metered by the client');
  return { severity: problems.length ? 'warn' : 'pass', problems };
}

/**
 * Pure: judge a forced tool-call response.
 * @param {{ok:boolean,status:number,json:any,text:string}} res
 * @returns {{outcome:'ok'|'not-honored'|'malformed'|'error', message:string}}
 */
export function evaluateToolCall(res) {
  if (!res.ok) return { outcome: 'error', message: `HTTP ${res.status}: ${res.json?.error?.message ?? res.text}` };
  const calls = res.json?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return { outcome: 'not-honored', message: 'model returned no tool call despite tool_choice' };
  const fn = calls[0]?.function;
  let args;
  try {
    args = typeof fn?.arguments === 'string' ? JSON.parse(fn.arguments) : fn?.arguments;
  } catch {
    return { outcome: 'malformed', message: 'tool call arguments were not valid JSON' };
  }
  if (fn?.name !== 'get_weather' || typeof args?.city !== 'string') {
    return { outcome: 'malformed', message: `tool call had unexpected shape (name=${fn?.name})` };
  }
  return { outcome: 'ok', message: 'valid tool call with JSON arguments' };
}

/**
 * Pure: an unknown model must yield a 4xx with an OpenAI-style `{error: {message}}` envelope.
 * @param {{status:number,json:any}} res
 * @returns {{severity:'pass'|'warn', message:string}}
 */
export function evaluateErrorEnvelope(res) {
  if (res.status >= 400 && res.status < 500 && typeof res.json?.error?.message === 'string') {
    return { severity: 'pass', message: `unknown model → ${res.status} with an error envelope` };
  }
  if (res.status >= 200 && res.status < 300) return { severity: 'warn', message: 'a nonexistent model id was accepted' };
  return { severity: 'warn', message: `unknown model → ${res.status} without an OpenAI-style error envelope` };
}

const TOOL_VENDORS = ['anthropic', 'openai', 'google', 'x-ai', 'mistralai'];

/** @type {import('./index.js').Check} */
export const compatCheck = {
  id: 'compat',
  title: 'OpenAI-compatible behaviour',
  weight: 15,
  method:
    'Streams a completion and inspects the SSE (deltas, [DONE], final usage chunk); forces a tool call and validates the JSON arguments; requests a nonexistent model and expects a 4xx error envelope.',
  limits: 'Does not test vision, audio, files, structured-output healing or provider-specific parameters.',

  async run(ctx) {
    if (!ctx.models.length) return { status: 'skip', summary: 'No models selected to audit.' };
    const ordered = [...ctx.models].sort((a, b) => rank(a.vendor) - rank(b.vendor));
    const streamModel = ordered[0];

    /** @type {Array<{name:string, severity:'pass'|'warn'|'fail', message:string}>} */
    const items = [];

    try {
      // 1. Streaming
      const settleStream = ctx.budget.reserve(estimateCallCost(streamModel, 40, 8) ?? 0n);
      try {
        const stream = await ctx.client.chatStream({ model: streamModel.id, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 8, temperature: 0 });
        const verdict = evaluateStream(stream);
        items.push({
          name: 'streaming', severity: verdict.severity,
          message: verdict.problems.length ? verdict.problems.join('; ') : `${stream.chunks.length} chunks, first event in ${Math.round(stream.firstEventMs ?? stream.ttfbMs)} ms, [DONE] and usage present`,
        });
        settleStream(streamUsageCost(streamModel, stream.usage));
        announceCall(ctx, streamModel, { tag: 'compat', ok: true, usage: stream.usage, latencyMs: Math.round(stream.elapsedMs ?? stream.ttfbMs ?? 0) });
      } catch (err) {
        items.push({ name: 'streaming', severity: 'fail', message: err.message });
        settleStream(null);
        announceCall(ctx, streamModel, { tag: 'compat', ok: false, error: err.message });
      }

      // 2. Forced tool call (try up to two models; some cheap models don't support tools at all)
      let toolItem = null;
      for (const model of ordered.slice(0, 2)) {
        const settle = ctx.budget.reserve(estimateCallCost(model, 150, 64) ?? 0n);
        try {
          const res = await ctx.client.chat({
            model: model.id,
            messages: [{ role: 'user', content: 'What is the weather in Lagos? Use the tool.' }],
            tools: [WEATHER_TOOL],
            tool_choice: { type: 'function', function: { name: 'get_weather' } },
            max_tokens: 64,
            temperature: 0,
          });
          const verdict = evaluateToolCall(res);
          settle(res.ok ? streamUsageCost(model, res.json?.usage) : null);
          announceCall(ctx, model, { tag: 'compat', ok: res.ok, status: res.status, usage: res.json?.usage, latencyMs: Math.round(res.elapsedMs ?? 0), error: res.ok ? null : `HTTP ${res.status}` });
          const item = {
            name: 'tool-calls',
            severity: /** @type {'pass'|'warn'|'fail'} */ (verdict.outcome === 'ok' ? 'pass' : verdict.outcome === 'malformed' ? 'fail' : 'warn'),
            message: `${model.id}: ${verdict.message}`,
          };
          toolItem = item;
          if (item.severity === 'pass') break;
        } catch (err) {
          settle(null);
          toolItem = { name: 'tool-calls', severity: /** @type {const} */ ('warn'), message: `${model.id}: ${err.message}` };
        }
      }
      if (toolItem) items.push(toolItem);
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      items.push({ name: 'budget', severity: 'warn', message: 'spend cap reached before every compatibility probe ran' });
    }

    // 3. Error envelope (free: the request is rejected before any model runs)
    try {
      const res = await ctx.client.chat({ model: 'assay/does-not-exist-000', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
      const verdict = evaluateErrorEnvelope(res);
      items.push({ name: 'error-envelope', severity: verdict.severity, message: verdict.message });
    } catch (err) {
      items.push({ name: 'error-envelope', severity: 'warn', message: err.message });
    }

    const worst = items.some((i) => i.severity === 'fail') ? 'fail' : items.some((i) => i.severity === 'warn') ? 'warn' : 'pass';
    const issues = items.filter((i) => i.severity !== 'pass');
    return {
      status: worst,
      summary: issues.length
        ? `${issues[0].name}: ${issues[0].message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}.`
        : `Streaming, forced tool call and error envelope all behave like the OpenAI API (${streamModel.id}).`,
      measured: Object.fromEntries(items.map((i) => [i.name, i.severity])),
      details: { items },
    };
  },
};

/** @param {string} vendor */
function rank(vendor) {
  const i = TOOL_VENDORS.indexOf(vendor);
  return i === -1 ? TOOL_VENDORS.length : i;
}

/** @param {import('../catalog.js').CatalogModel} model @param {any} usage */
function streamUsageCost(model, usage) {
  if (!usage || model.promptPrice === null || model.completionPrice === null) return null;
  if (!Number.isInteger(usage.prompt_tokens) || !Number.isInteger(usage.completion_tokens)) return null;
  return model.promptPrice * BigInt(usage.prompt_tokens) + model.completionPrice * BigInt(usage.completion_tokens);
}
