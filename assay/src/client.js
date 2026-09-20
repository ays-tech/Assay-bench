import { redact, clip } from './redact.js';
import { iterateSse } from './sse.js';
import { VERSION } from './config.js';

/** Raised when the network layer fails (DNS, TLS, timeout, reset). Never contains the key. */
export class AssayNetworkError extends Error {
  constructor(message, { cause, url } = {}) {
    super(message, { cause });
    this.name = 'AssayNetworkError';
    this.url = url;
  }
}

const HEADER_PATTERN = /^(x-orbio-|x-openrouter-|x-request-id|server-timing|x-ratelimit|retry-after|openai-|cf-ray|content-type)/i;

/**
 * Keep only headers relevant to an audit, as a plain lowercase object.
 * @param {Headers} headers
 */
export function pickHeaders(headers) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [name, value] of headers.entries()) {
    if (HEADER_PATTERN.test(name)) out[name.toLowerCase()] = value;
  }
  return out;
}

/**
 * @typedef {object} HttpResult
 * @property {number} status
 * @property {boolean} ok
 * @property {Record<string,string>} headers   audit-relevant response headers
 * @property {any} json                        parsed body or null
 * @property {string} text                     raw body (redacted, clipped)
 * @property {number} elapsedMs                request start → body fully read
 * @property {number} ttfbMs                   request start → headers received
 */

/**
 * Thin gateway client. Deliberately does not retry chat calls: a retry would be billed
 * twice and corrupt the reconciliation the audit depends on.
 */
export class OrbioClient {
  /**
   * @param {{baseUrl: string, apiKey: string, timeoutMs?: number, fetchImpl?: typeof fetch, label?: string}} opts
   */
  constructor({ baseUrl, apiKey, timeoutMs = 45_000, fetchImpl = globalThis.fetch, label = 'gateway' }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.label = label;
  }

  /** Same gateway, different credential (used for the bad-key probe). @param {string} apiKey */
  withKey(apiKey) {
    return new OrbioClient({ baseUrl: this.baseUrl, apiKey, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, label: this.label });
  }

  /** @param {string} path */
  url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * @param {string} path
   * @param {{method?: string, body?: unknown, timeoutMs?: number}} [opts]
   * @returns {Promise<HttpResult>}
   */
  async request(path, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    const url = this.url(path);
    const started = performance.now();
    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.#headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw this.#networkError(err, url);
    }
    const ttfbMs = performance.now() - started;
    let raw;
    try {
      raw = await res.text();
    } catch (err) {
      throw this.#networkError(err, url);
    }
    const elapsedMs = performance.now() - started;
    return {
      status: res.status,
      ok: res.ok,
      headers: pickHeaders(res.headers),
      json: safeJson(raw),
      text: clip(redact(raw, [this.apiKey])),
      elapsedMs,
      ttfbMs,
    };
  }

  /**
   * GET with a single retry on network error or 5xx. Safe because GETs are free.
   * @param {string} path
   */
  async get(path) {
    try {
      const first = await this.request(path);
      if (first.status < 500) return first;
    } catch {
      /* fall through to one retry */
    }
    return this.request(path);
  }

  /** @param {object} body OpenAI-style chat request */
  chat(body) {
    return this.request('/chat/completions', { method: 'POST', body });
  }

  /**
   * Streaming chat. Returns a summary rather than an iterator because the audit only needs
   * shape and timing, not incremental delivery.
   * @param {object} body
   * @returns {Promise<{status:number, headers:Record<string,string>, ttfbMs:number, firstEventMs:number|null,
   *   elapsedMs:number, events:number, chunks:any[], doneSeen:boolean, text:string, usage:any, malformed:number, errorText?:string}>}
   */
  async chatStream(body) {
    const url = this.url('/chat/completions');
    const started = performance.now();
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw this.#networkError(err, url);
    }
    const ttfbMs = performance.now() - started;
    const summary = {
      status: res.status,
      headers: pickHeaders(res.headers),
      ttfbMs,
      firstEventMs: /** @type {number|null} */ (null),
      elapsedMs: 0,
      events: 0,
      chunks: /** @type {any[]} */ ([]),
      doneSeen: false,
      text: '',
      usage: null,
      malformed: 0,
      errorText: undefined,
    };
    if (!res.ok || !res.body) {
      summary.errorText = clip(redact(await res.text().catch(() => ''), [this.apiKey]));
      summary.elapsedMs = performance.now() - started;
      return summary;
    }
    try {
      for await (const evt of iterateSse(/** @type {any} */ (res.body))) {
        summary.events += 1;
        if (summary.firstEventMs === null) summary.firstEventMs = performance.now() - started;
        if (evt.data.trim() === '[DONE]') {
          summary.doneSeen = true;
          continue;
        }
        const chunk = safeJson(evt.data);
        if (!chunk) {
          summary.malformed += 1;
          continue;
        }
        summary.chunks.push(chunk);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') summary.text += delta;
        if (chunk.usage) summary.usage = chunk.usage;
      }
    } catch (err) {
      throw this.#networkError(err, url);
    }
    summary.elapsedMs = performance.now() - started;
    return summary;
  }

  /** @param {boolean} hasBody */
  #headers(hasBody) {
    /** @type {Record<string,string>} */
    const h = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `assay/${VERSION}`,
    };
    if (hasBody) h['Content-Type'] = 'application/json';
    return h;
  }

  /** @param {any} err @param {string} url */
  #networkError(err, url) {
    const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.cause?.code || err?.code || err?.message || 'network error';
    return new AssayNetworkError(`${this.label} request failed (${redact(String(reason), [this.apiKey])})`, { cause: err, url });
  }
}

/** @param {string} text */
export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
