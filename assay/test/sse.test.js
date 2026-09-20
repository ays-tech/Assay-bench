import test from 'node:test';
import assert from 'node:assert/strict';
import { iterateSse } from '../src/sse.js';

async function collect(chunks) {
  const out = [];
  for await (const e of iterateSse((async function* () { yield* chunks; })())) out.push(e);
  return out;
}

test('parses events split across arbitrary chunk boundaries', async () => {
  const text = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n';
  const chunks = text.match(/.{1,5}/gs);
  const events = await collect(chunks);
  assert.deepEqual(events.map((e) => e.data), ['{"a":1}', '{"a":2}', '[DONE]']);
});

test('ignores comment keep-alives and handles CRLF', async () => {
  const events = await collect([': OPENROUTER PROCESSING\r\n\r\ndata: hi\r\n\r\n']);
  assert.deepEqual(events, [{ event: 'message', data: 'hi' }]);
});

test('joins multi-line data and reads event names', async () => {
  const events = await collect(['event: ping\ndata: a\ndata: b\n\n']);
  assert.deepEqual(events, [{ event: 'ping', data: 'a\nb' }]);
});

test('decodes multi-byte characters split across byte chunks', async () => {
  const bytes = new TextEncoder().encode('data: 日本語\n\n');
  const events = await collect([bytes.slice(0, 8), bytes.slice(8)]);
  assert.equal(events[0].data, '日本語');
});

test('flushes a final event with no trailing blank line', async () => {
  const events = await collect(['data: tail']);
  assert.equal(events[0].data, 'tail');
});
