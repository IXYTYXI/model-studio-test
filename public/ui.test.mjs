import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, splitContent } from './ui-lib.js';
import * as ui from './ui-lib.js';

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

test('Google sign-in starts without an authenticated CSRF token', async () => {
  let options;
  const api = createApi({ getToken: () => 'unrelated-token', fetcher: async (_path, request) => {
    options = request;
    return new Response(JSON.stringify({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }));
  }});
  await api('/api/auth/google/start', { method: 'POST', body: {} });
  assert.equal(options.headers['X-CSRF-Token'], undefined);
  assert.equal(options.credentials, 'same-origin');
});

test('OAuth navigation only accepts the HTTPS Google accounts origin', () => {
  assert.equal(typeof ui.googleAuthorizationUrl, 'function');
  assert.equal(ui.googleAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?state=example'), 'https://accounts.google.com/o/oauth2/v2/auth?state=example');
  for (const url of ['https://accounts.google.com.evil.example/auth', 'http://accounts.google.com/auth', 'javascript:alert(1)', '/login', 'https://user:pass@accounts.google.com/auth', null]) {
    assert.throws(() => ui.googleAuthorizationUrl(url), /Google 登录暂时不可用/);
  }
});

test('OAuth callback errors use fixed messages without reflecting query contents', () => {
  assert.equal(typeof ui.googleLoginError, 'function');
  assert.match(ui.googleLoginError('cancelled'), /取消/);
  assert.match(ui.googleLoginError('capacity'), /成员上限/);
  for (const code of ['failed', 'disabled', 'unavailable']) assert.equal(typeof ui.googleLoginError(code), 'string');
  assert.equal(ui.googleLoginError('<script>token=secret</script>'), ui.googleLoginError('failed'));
  assert.equal(ui.googleLoginError(null), '');
});

test('API cancellation is forwarded without reporting a failed login',async()=>{
 const c=new AbortController();let seen;
 const api=createApi({fetcher:async(_url,options)=>{seen=options.signal;throw new DOMException('Aborted','AbortError');}});
 c.abort();await assert.rejects(api('/api/account/providers/openai/models',{method:'POST',body:{},signal:c.signal}),e=>e.name==='AbortError');assert.equal(seen,c.signal);
});
