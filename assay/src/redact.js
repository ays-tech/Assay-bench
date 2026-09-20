import { createHash } from 'node:crypto';

const KEY_LIKE = /\bsk-[A-Za-z0-9_\-+/=.]{8,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9_\-+/=.]{8,}/gi;

/**
 * Remove anything that looks like a credential from text destined for logs or reports.
 * @param {unknown} text
 * @param {string[]} [secrets] exact secrets to strip in addition to pattern matches
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let out = typeof text === 'string' ? text : safeStringify(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out.replace(BEARER, 'Bearer [redacted]').replace(KEY_LIKE, 'sk-[redacted]');
}

/** Short, non-reversible identifier for a key, safe to store in reports. */
export function keyFingerprint(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 8);
}

/** @param {unknown} v */
function safeStringify(v) {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Trim to a maximum length for embedding in messages.
 * @param {string} s @param {number} [n]
 */
export function clip(s, n = 300) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
