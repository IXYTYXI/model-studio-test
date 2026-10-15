import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, splitContent } from './ui-lib.js';

test('authenticated writes include CSRF and same-origin credentials', async () => {
  let observed;
  const api = createApi({ getToken: () => 'token', fetcher: async (url, options) => {
    observed = { url, options };
    return new Response(JSON.stringify({ ok: true }));
  }});
  await api('/api/chat', { method: 'POST', body: { message: 'hello' } });
  assert.equal(observed.options.headers['X-CSRF-Token'], 'token');
  assert.equal(observed.options.credentials, 'same-origin');
  assert.equal(observed.options.body, '{"message":"hello"}');
});

test('session expiry is reported once while login failure stays on the form', async () => {
  let expired = 0;
  const api = createApi({ onUnauthorized: () => expired++, fetcher: async () => new Response(JSON.stringify({ error: { message: '请重新登录', code: 'unauthorized' } }), { status: 401 }) });
  await assert.rejects(api('/api/conversations'), /请重新登录/);
  assert.equal(expired, 1);
  await assert.rejects(api('/api/login', { method: 'POST', body: {} }), /请重新登录/);
  assert.equal(expired, 1);
});

test('content parser keeps HTML literal and separates fenced code without dropping text', () => {
  assert.deepEqual(splitContent('前文 <img onerror=x>\n```js\nconst x = "<script>";\n```\n后文'), [
    { type: 'text', content: '前文 <img onerror=x>\n' },
    { type: 'code', language: 'js', content: 'const x = "<script>";\n' },
    { type: 'text', content: '\n后文' }
  ]);
  assert.deepEqual(splitContent('```unfinished'), [{ type: 'text', content: '```unfinished' }]);
});
