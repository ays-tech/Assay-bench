/**
 * JSON extraction and a small JSON-Schema subset validator.
 *
 * Models wrap JSON in prose or ``` fences all the time; a benchmark that fails a model for
 * that would be measuring formatting habits, not correctness, so extraction is forgiving.
 * Validation, by contrast, is strict.
 */

/**
 * @param {unknown} text
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty response' };
  const trimmed = text.trim();
  const attempt = (s) => {
    try {
      return { ok: /** @type {const} */ (true), value: JSON.parse(s) };
    } catch {
      return null;
    }
  };
  const whole = attempt(trimmed);
  if (whole) return whole;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    const fenced = attempt(fence[1].trim());
    if (fenced) return fenced;
  }

  // First balanced {...} or [...] in the text, honouring strings and escapes.
  for (let start = 0; start < trimmed.length; start++) {
    const open = trimmed[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        const found = attempt(trimmed.slice(start, i + 1));
        if (found) return found;
        break;
      }
    }
  }
  return { ok: false, error: 'no valid JSON found in the response' };
}

/** @param {unknown} v */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

/**
 * Validate `value` against a JSON-Schema subset: type, enum, required, properties,
 * additionalProperties:false, items, min/max, minLength/maxLength, minItems/maxItems.
 * @param {any} value @param {any} schema @param {string} [path]
 * @returns {string[]} human-readable errors; empty means valid
 */
export function validateSchema(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const matches = allowed.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!matches) {
      errors.push(`${path}: expected ${allowed.join(' or ')}, got ${actual}`);
      return errors;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) if (key in value) errors.push(...validateSchema(value[key], sub, `${path}.${key}`));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
    }
  }
  return errors;
}
