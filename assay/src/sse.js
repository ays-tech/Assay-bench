/**
 * Minimal Server-Sent Events parser for OpenAI-style streaming.
 * Handles chunk boundaries anywhere (even mid-UTF-8), CRLF, comment keep-alives
 * (": OPENROUTER PROCESSING") and multi-line data fields.
 */

/**
 * @param {AsyncIterable<Uint8Array|string>} source
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function* iterateSse(source) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseBlock(buffer.replace(/\r\n/g, '\n'));
    if (parsed) yield parsed;
  }
}

/** @param {string} block */
function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}
