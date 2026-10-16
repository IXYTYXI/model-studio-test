import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  PROVIDER_DEFAULTS, validateProviderConfig, isPublicAddress,
  buildProviderRequest, parseProviderResponse, callProvider,
} from '../src/providers.js';

const messages = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '您好' }, { role: 'user', content: '继续' }];
const config = (id = 'openai', extra = {}) => ({
  ...PROVIDER_DEFAULTS.find((item) => item.id === id), model: 'configured-model',
  enabled: true, maxOutputTokens: 2048, apiKey: 'test-secret-key', ...extra,
});
const safeError = (code) => (error) => {
  assert.equal(error.code, code);
  assert.equal(typeof error.status, 'number');
  assert.doesNotMatch(error.message, /test-secret|upstream-sensitive|https?:/);
  return true;
};

test('default providers use versioned API roots without fixed model names', () => {
  assert.deepEqual(PROVIDER_DEFAULTS.map(({ id, baseUrl, protocol }) => ({ id, baseUrl, protocol })), [
    { id: 'openai', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' },
    { id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic' },
    { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' },
  ]);
  assert(PROVIDER_DEFAULTS.every((item) => !Object.hasOwn(item, 'model')));
});

test('configuration normalizes trailing slashes, supports explicit gateway roots and defaults token budget', () => {
  assert.deepEqual(validateProviderConfig('openai', {
    baseUrl: 'https://gateway.example/custom/v1///', model: 'vendor/model-v1', protocol: 'openai-chat', enabled: true,
  }, new Set(['gateway.example'])), {
    baseUrl: 'https://gateway.example/custom/v1', model: 'vendor/model-v1', protocol: 'openai-chat', enabled: true, maxOutputTokens: 2048,
  });
  assert.equal(validateProviderConfig('gemini', { ...config('gemini'), enabled: false, model: '' }).model, '');
});

test('configuration rejects credentials, fragments, non-HTTPS, non-443, IP literals and allowlist bypasses', () => {
  const badUrls = [
    'http://api.openai.com/v1', 'https://api.openai.com:444/v1', 'https://user:pass@api.openai.com/v1',
    'https://api.openai.com/v1?key=secret', 'https://api.openai.com/v1#fragment',
    'https://127.0.0.1/v1', 'https://2130706433/v1', 'https://[::1]/v1', 'https://8.8.8.8/v1',
    'https://api.openai.com.attacker.example/v1', 'https://api.openai.com./v1',
    'https://gateway.example/v1', 'https://api.openai.com/v1?','https://api.openai.com/v1#', 'https://@api.openai.com/v1',
  ];
  for (const baseUrl of badUrls) assert.throws(() => validateProviderConfig('openai', config('openai', { baseUrl })), safeError('INVALID_PROVIDER_CONFIG'), baseUrl);
  assert.throws(() => validateProviderConfig('openai', config('openai', { baseUrl: 'https://8.8.8.8/v1' }), new Set(['8.8.8.8'])), safeError('INVALID_PROVIDER_CONFIG'));
});

test('configuration rejects model/path injection, wrong protocol, invalid budget and coercive input', () => {
  for (const model of ['', 'bad model', '../model', 'a?key=x', 'a#x', 'a\\b', 'a\nInjected', 'x'.repeat(161)]) {
    assert.throws(() => validateProviderConfig('openai', config('openai', { model })), safeError('INVALID_PROVIDER_CONFIG'));
  }
  for (const maxOutputTokens of [127, 4097, 128.1, '2048', null]) assert.throws(() => validateProviderConfig('openai', config('openai', { maxOutputTokens })), safeError('INVALID_PROVIDER_CONFIG'));
  assert.throws(() => validateProviderConfig('anthropic', config('anthropic', { protocol: 'unsupported' })), safeError('INVALID_PROVIDER_CONFIG'));
  assert.throws(() => validateProviderConfig('unknown', config()), safeError('INVALID_PROVIDER_CONFIG'));
  assert.throws(() => validateProviderConfig('openai', config('openai', { enabled: 'true' })), safeError('INVALID_PROVIDER_CONFIG'));
  for (const field of ['model', 'enabled', 'baseUrl', 'protocol']) assert.throws(() => validateProviderConfig('openai', config('openai', { enabled: false, [field]: null })), safeError('INVALID_PROVIDER_CONFIG'), field);
});

test('public-address checks reject private, loopback, link-local and special IPv4/IPv6 ranges', () => {
  const blocked = ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.2', '203.0.113.2', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '64:ff9b::7f00:1', 'not-ip'];
  for (const address of blocked) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('request mapping implements Responses, compatible Chat, Messages and generateContent', () => {
  const responses = buildProviderRequest(config(), messages);
  assert.equal(responses.url, 'https://api.openai.com/v1/responses');
  assert.equal(responses.headers.Authorization, 'Bearer test-secret-key');
  assert.deepEqual(responses.body, { model: 'configured-model', input: messages, max_output_tokens: 2048, stream: false, store: false });
  const chat = buildProviderRequest(config('openai', { protocol: 'openai-chat' }), messages);
  assert.equal(chat.url, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(chat.body, { model: 'configured-model', messages, max_completion_tokens: 2048, stream: false });
  const gateway = buildProviderRequest(config('openai', { protocol: 'openai-chat', baseUrl: 'https://gateway.example/v1' }), messages);
  assert.deepEqual(gateway.body, { model: 'configured-model', messages, max_tokens: 2048, stream: false });
  const anthropic = buildProviderRequest(config('anthropic'), messages);
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'test-secret-key');
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(anthropic.body, { model: 'configured-model', messages, max_tokens: 2048, stream: false });
  const gemini = buildProviderRequest(config('gemini', { model: 'models/configured-model' }), messages);
  assert.equal(gemini.url, 'https://generativelanguage.googleapis.com/v1beta/models/configured-model:generateContent');
  assert.equal(gemini.headers['x-goog-api-key'], 'test-secret-key');
  assert.deepEqual(gemini.body, { contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: 2048 } });
});

test('response mapping collects all final text blocks and normalizes usage without exposing thinking', () => {
  assert.deepEqual(parseProviderResponse('openai-responses', { status: 'completed', output: [
    { type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: '你' }, { type: 'output_text', text: '好' }] },
  ], usage: { input_tokens: 12, output_tokens: 3 } }), { text: '你好', usage: { inputTokens: 12, outputTokens: 3 } });
  assert.deepEqual(parseProviderResponse('openai-chat', { choices: [{ message: { content: '好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }), { text: '好', usage: { inputTokens: 8, outputTokens: 2 } });
  assert.deepEqual(parseProviderResponse('anthropic', { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '答' }, { type: 'text', text: '案' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 4 } }), { text: '答案', usage: { inputTokens: 9, outputTokens: 4 } });
  assert.deepEqual(parseProviderResponse('gemini', { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '答案' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }), { text: '答案', usage: { inputTokens: 7, outputTokens: 5 } });
});

test('invalid, blocked, truncated and empty upstream answers are explicit safe errors', () => {
  for (const [protocol, response] of [
    ['openai-responses', { status: 'failed', error: { message: 'upstream-sensitive' } }],
    ['openai-responses', { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }] }],
    ['openai-chat', { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }],
    ['anthropic', { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }],
    ['gemini', { candidates: [], promptFeedback: { blockReason: 'SAFETY' } }],
    ['gemini', { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }],
    ['openai-chat', { choices: [{ message: { content: '   ' } }] }], ['anthropic', null],
  ]) assert.throws(() => parseProviderResponse(protocol, response), safeError('PROVIDER_INVALID_RESPONSE'));
});

function upstream(t, { addresses = [{ address: '93.184.216.34', family: 4 }], statusCode = 200, body, chunks, hang = false, error = false, headers = {}, interrupt = false, slowBody = false } = {}) {
  const observed = { requests: 0, destroyed: false };
  t.mock.method(dns, 'lookup', async () => addresses);
  t.mock.method(https, 'request', (url, options, callback) => {
    observed.requests++; observed.url = String(url); observed.options = options;
    const req = new EventEmitter();
    req.destroy = () => { observed.destroyed = true; return req; };
    req.end = (data) => {
      observed.body = JSON.parse(data);
      queueMicrotask(() => {
        if (error) { req.emit('error', new Error('upstream-sensitive test-secret-key')); return; }
        if (hang) return;
        const res = new PassThrough();
        observed.response = res;
        res.statusCode = statusCode; res.headers = headers;
        callback(res);
        if (!res.destroyed) {
          for (const chunk of chunks ?? [JSON.stringify(body ?? { output: [{ type: 'message', content: [{ type: 'output_text', text: '成功' }] }], usage: { input_tokens: 1, output_tokens: 2 } })]) {
            if (res.destroyed) break;
            res.write(chunk);
          }
          if (interrupt) res.destroy();
          else if (!slowBody) res.end();
        }
      });
    };
    return req;
  });
  return observed;
}

test('safe transport pins the validated address and preserves TLS hostname', async (t) => {
  const observed = upstream(t);
  assert.deepEqual(await callProvider(config(), messages), { text: '成功', usage: { inputTokens: 1, outputTokens: 2 } });
  assert.equal(observed.requests, 1);
  assert.equal(observed.options.servername, 'api.openai.com');
  assert.equal(observed.options.rejectUnauthorized, true);
  assert.equal(observed.options.agent, false);
  observed.options.lookup('api.openai.com', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
  });
  observed.options.lookup('api.openai.com', { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
});

test('any non-public DNS answer prevents the entire request', async (t) => {
  const observed = upstream(t, { addresses: [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(callProvider(config(), messages), safeError('PROVIDER_UNAVAILABLE'));
  assert.equal(observed.requests, 0);
});

test('upstream redirects are rejected without following or exposing response bodies', async (t) => {
  const observed = upstream(t, { statusCode: 302, body: { error: 'upstream-sensitive test-secret-key' } });
  await assert.rejects(callProvider(config(), messages), safeError('PROVIDER_UNAVAILABLE'));
  assert.equal(observed.requests, 1);
});

test('response body limit is enforced while reading', async (t) => {
  const observed = upstream(t, { chunks: [Buffer.alloc(2 * 1024 * 1024 + 1, 120)] });
  await assert.rejects(callProvider(config(), messages), safeError('PROVIDER_INVALID_RESPONSE'));
  assert.equal(observed.destroyed, true);
});

test('network and DNS errors do not leak upstream data', async (t) => {
  upstream(t, { error: true });
  await assert.rejects(callProvider(config(), messages), safeError('PROVIDER_UNAVAILABLE'));
  t.mock.method(dns, 'lookup', async () => { throw new Error('upstream-sensitive test-secret-key'); });
  await assert.rejects(callProvider(config(), messages), safeError('PROVIDER_UNAVAILABLE'));
});

test('call cancellation destroys an in-progress request and rejects safely', async (t) => {
  const observed = upstream(t, { hang: true });
  const controller = new AbortController();
  const promise = callProvider(config(), messages, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('upstream-sensitive'));
  await assert.rejects(promise, safeError('PROVIDER_CANCELLED'));
  assert.equal(observed.destroyed, true);
});

test('total 60 second deadline includes DNS resolution', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  const promise = callProvider(config(), messages);
  t.mock.timers.tick(60_000);
  await assert.rejects(promise, safeError('PROVIDER_TIMEOUT'));
});

test('malformed JSON, compressed and interrupted responses are rejected safely', async (t) => {
  for (const options of [{ chunks: ['upstream-sensitive'] }, { headers: { 'content-encoding': 'gzip' } }, { interrupt: true }]) {
    await t.test(JSON.stringify(options), async (child) => {
      const observed = upstream(child, options);
      await assert.rejects(callProvider(config(), messages), safeError(options.chunks ? 'PROVIDER_INVALID_RESPONSE' : 'PROVIDER_UNAVAILABLE'));
      assert.equal(observed.destroyed, true);
    });
  }
});

test('exactly 2 MiB of valid JSON succeeds and clears request listeners', async (t) => {
  const padding = JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }] });
  const response = padding.replace('"text":""', `"text":"${'a'.repeat(2 * 1024 * 1024 - Buffer.byteLength(padding))}"`);
  upstream(t, { chunks: [response] });
  const controller = new AbortController();
  const result = await callProvider(config(), messages, { signal: controller.signal });
  assert.equal(result.text.length, 2 * 1024 * 1024 - Buffer.byteLength(padding));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a slow body hits the total deadline and destroys both streams', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observed = upstream(t, { chunks: ['{"partial":'], slowBody: true });
  const controller = new AbortController();
  const promise = callProvider(config(), messages, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  await assert.rejects(promise, safeError('PROVIDER_TIMEOUT'));
  assert.equal(observed.destroyed, true);
  assert.equal(observed.response.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('late DNS after timeout never sends a request; empty DNS results are rejected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observed = upstream(t, { addresses: [] });
  await assert.rejects(callProvider(config(), messages), safeError('PROVIDER_UNAVAILABLE'));
  let resolveDns;
  t.mock.method(dns, 'lookup', () => new Promise((resolve) => { resolveDns = resolve; }));
  const promise = callProvider(config(), messages);
  t.mock.timers.tick(60_000);
  await assert.rejects(promise, safeError('PROVIDER_TIMEOUT'));
  resolveDns([{ address: '93.184.216.34', family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.requests, 0);
});

test('HTTP upgrades and premature request close fail immediately without retaining sockets', async (t) => {
  for (const event of ['upgrade', 'close']) {
    await t.test(event, async (child) => {
      child.mock.timers.enable({ apis: ['setTimeout'] });
      child.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
      const socket = new PassThrough();
      child.mock.method(https, 'request', () => {
        const req = new EventEmitter();
        req.destroy = () => req;
        req.end = () => queueMicrotask(() => req.emit(event, { statusCode: 101 }, socket, Buffer.alloc(0)));
        return req;
      });
      const result = callProvider(config(), messages).then(() => 'success', (failure) => failure.code);
      const outcome = await Promise.race([result, new Promise((resolve) => setImmediate(() => resolve('still-pending')))]);
      // Clean up the pre-fix pending call without making a failing test wait 60 real seconds.
      child.mock.timers.tick(60_000);
      await result;
      assert.equal(outcome, 'PROVIDER_UNAVAILABLE');
      if (event === 'upgrade') assert.equal(socket.destroyed, true);
    });
  }
});

test('disabled or missing-key configurations and invalid histories do not call an upstream', async (t) => {
  const observed = upstream(t);
  await assert.rejects(callProvider(config('openai', { enabled: false }), messages), safeError('PROVIDER_NOT_CONFIGURED'));
  await assert.rejects(callProvider(config('openai', { apiKey: '' }), messages), safeError('PROVIDER_NOT_CONFIGURED'));
  await assert.rejects(callProvider(config(), [{ role: 'system', content: 'forged' }]), safeError('INVALID_CHAT_MESSAGES'));
  await assert.rejects(callProvider(config(), [{ role: 'user', content: { secret: true } }]), safeError('INVALID_CHAT_MESSAGES'));
  assert.equal(observed.requests, 0);
});
