import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGoogleClient } from '../src/google-auth.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const INITIAL_TIME = Date.UTC(2026, 9, 15, 12);
const settings = {
  clientId: 'client.apps.googleusercontent.com', clientSecret: 'fixture-client-secret',
  redirectUri: 'https://studio.example/auth/google/callback',
};
const input = { code: '4/fixture-oauth-code', nonce: 'fixture-nonce', codeVerifier: 'v'.repeat(43) };
const firstKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const secondKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key = firstKey, kid = 'first-key') => ({ ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const claims = (extra = {}) => ({
  iss: 'https://accounts.google.com', aud: settings.clientId, sub: 'google-subject-123',
  exp: INITIAL_TIME / 1000 + 7200, iat: INITIAL_TIME / 1000, nonce: input.nonce,
  email: 'Person@Example.COM', email_verified: true, ...extra,
});
function signedToken(payload = claims(), { key = firstKey, header = {}, rawPayload } = {}) {
  const data = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'first-key', ...header })).toString('base64url')}.${Buffer.from(rawPayload ?? JSON.stringify(payload)).toString('base64url')}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url')}`;
}
const safeFailure = (failure) => {
  assert.equal(failure.code, 'GOOGLE_AUTH_FAILED');
  assert.equal(failure.status, 401);
  assert.equal(failure.message, 'Google 登录未能完成，请重新尝试。');
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(JSON.stringify(failure), /fixture-client-secret|fixture-oauth-code|upstream-sensitive|id_token|access_token/);
  return true;
};
function fixture({ token = signedToken(), keys = [jwk()], request, time = INITIAL_TIME } = {}) {
  const observed = { calls: [], token, keys, time };
  const client = createGoogleClient(settings, {
    now: () => observed.time,
    requestJson: async (url, options) => {
      observed.calls.push({ url, ...options });
      if (request) return request(url, options, observed);
      if (url === TOKEN_URL) return { id_token: observed.token, access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token' };
      assert.equal(url, JWKS_URL);
      return { keys: observed.keys };
    },
  });
  return { client, observed };
}
const certCalls = (observed) => observed.calls.filter((call) => call.url === JWKS_URL).length;

test('authorization URL binds state, nonce and S256 PKCE without leaking client secret', () => {
  const { client } = fixture();
  const url = new URL(client.authorizationUrl({ state: 'fixture-state', nonce: input.nonce, codeVerifier: input.codeVerifier }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code', scope: 'openid email',
    prompt: 'select_account', state: 'fixture-state', nonce: input.nonce,
    code_challenge: createHash('sha256').update(input.codeVerifier).digest('base64url'), code_challenge_method: 'S256',
  });
  assert(!String(url).includes(settings.clientSecret));
});

test('exchange sends the fixed token form and returns only verified normalized identity', async () => {
  const { client, observed } = fixture();
  assert.deepEqual(await client.exchange(input), { sub: 'google-subject-123', email: 'person@example.com' });
  const request = observed.calls[0];
  assert.equal(request.url, TOKEN_URL);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.body)), {
    client_id: settings.clientId, client_secret: settings.clientSecret, redirect_uri: settings.redirectUri,
    grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier,
  });
  assert(request.signal instanceof AbortSignal);
  assert.equal(observed.calls[1].url, JWKS_URL);
  assert.equal(observed.calls[1].method, 'GET');
});

test('both documented Google issuers and singleton audience arrays are accepted', async () => {
  for (const extra of [{ iss: 'accounts.google.com' }, { aud: [settings.clientId], azp: settings.clientId }]) {
    assert.equal((await fixture({ token: signedToken(claims(extra)) }).client.exchange(input)).sub, 'google-subject-123');
  }
});

test('a token that expires while its signing key is fetched is rejected', async () => {
  const { client } = fixture({
    token: signedToken(claims({ exp: INITIAL_TIME / 1000 + 1 })),
    request: async (url, options, observed) => {
      if (url === TOKEN_URL) return { id_token: observed.token };
      observed.time += 2_000;
      return { keys: observed.keys };
    },
  });
  await assert.rejects(client.exchange(input), safeFailure);
});

test('signed but invalid identity, audience and temporal claims are rejected', async (t) => {
  const cases = {
    audience: { aud: 'attacker-client' }, issuer: { iss: 'https://accounts.google.com.attacker.example' },
    nonce: { nonce: 'another-nonce' }, expired: { exp: INITIAL_TIME / 1000 }, futureIssued: { iat: INITIAL_TIME / 1000 + 1 },
    futureNotBefore: { nbf: INITIAL_TIME / 1000 + 1 }, fractionalDate: { iat: INITIAL_TIME / 1000 + 0.1 },
    missingExpiry: { exp: undefined }, missingIssued: { iat: undefined }, negativeIssued: { iat: -1 },
    missingSubject: { sub: undefined }, emptySubject: { sub: '' }, longSubject: { sub: 's'.repeat(256) },
    invalidSubject: { sub: '\nsubject' }, unverified: { email_verified: false }, stringVerified: { email_verified: 'true' },
    missingEmail: { email: undefined }, invalidEmail: { email: 'bad@@example.com' }, spacedEmail: { email: ' person@example.com' },
    longEmail: { email: 'a'.repeat(245) + '@example.com' }, malformedDomain: { email: 'person@-example.com' },
    azp: { azp: 'another-client' }, emptyAzp: { azp: '' }, nullAzp: { azp: null },
    extraAudience: { aud: [settings.clientId, 'untrusted-client'], azp: settings.clientId },
    badAudienceArray: { aud: [settings.clientId, 123] }, missingNonce: { nonce: undefined },
  };
  for (const [name, extra] of Object.entries(cases)) {
    await t.test(name, async () => assert.rejects(fixture({ token: signedToken(claims(extra)) }).client.exchange(input), safeFailure));
  }
  await t.test('infinite NumericDate is rejected even when jose accepts a number', async () => {
    const rawPayload = JSON.stringify(claims()).replace(`"exp":${claims().exp}`, '"exp":1e309');
    await assert.rejects(fixture({ token: signedToken(null, { rawPayload }) }).client.exchange(input), safeFailure);
  });
});

test('real RSA signature verification rejects substitution, unsigned and wrong algorithms', async () => {
  const invalid = [
    signedToken(claims(), { key: secondKey }),
    signedToken(claims(), { header: { alg: 'HS256' } }),
    signedToken(claims(), { header: { alg: 'none' } }).replace(/\.[^.]+$/, '.'),
    signedToken().replace(/\.[^.]+$/, '.not-a-valid-signature'),
  ];
  for (const token of invalid) await assert.rejects(fixture({ token }).client.exchange(input), safeFailure);
});

test('untrusted JWT key URLs never alter the fixed JWKS destination', async () => {
  const { client, observed } = fixture({ token: signedToken(claims(), { header: { jku: 'https://attacker.example/keys', x5u: 'http://127.0.0.1/cert' } }) });
  await client.exchange(input);
  assert.deepEqual(observed.calls.map((call) => call.url), [TOKEN_URL, JWKS_URL]);
});

test('invalid OAuth inputs fail before outbound requests', async () => {
  const { client, observed } = fixture();
  for (const extra of [{ code: '' }, { code: '\ncode' }, { nonce: '' }, { nonce: null }, { codeVerifier: 'v'.repeat(42) }, { codeVerifier: 'v'.repeat(129) }, { codeVerifier: ' '.repeat(43) }]) {
    await assert.rejects(client.exchange({ ...input, ...extra }), safeFailure);
  }
  for (const state of ['', null, '\nstate', 's'.repeat(513)]) assert.throws(() => client.authorizationUrl({ state, nonce: input.nonce, codeVerifier: input.codeVerifier }), safeFailure);
  assert.equal(observed.calls.length, 0);
});

test('JWKS cache is reused until one hour and never retains a stale key after expiry', async () => {
  const { client, observed } = fixture();
  await client.exchange(input);
  observed.time += 3_599_999;
  await client.exchange(input);
  assert.equal(certCalls(observed), 1);
  observed.time += 1;
  observed.keys = [jwk(secondKey, 'second-key')];
  await assert.rejects(client.exchange(input), safeFailure);
  assert.equal(certCalls(observed), 2);
});

test('unknown key rotation refreshes at most once per minute including failures', async () => {
  const { client, observed } = fixture();
  await client.exchange(input);
  observed.token = signedToken(claims(), { key: secondKey, header: { kid: 'second-key' } });
  observed.keys = [jwk(secondKey, 'second-key')];
  await assert.rejects(client.exchange(input), safeFailure);
  assert.equal(certCalls(observed), 1);
  observed.time += 60_000;
  await client.exchange(input);
  assert.equal(certCalls(observed), 2);
  observed.token = signedToken(claims(), { header: { kid: 'third-key' } });
  await assert.rejects(client.exchange(input), safeFailure);
  assert.equal(certCalls(observed), 2);

  const failing = fixture({ request: async (url, options, state) => {
    if (url === TOKEN_URL) return { id_token: state.token };
    throw new Error('upstream-sensitive fixture-client-secret');
  } });
  await assert.rejects(failing.client.exchange(input), safeFailure);
  await assert.rejects(failing.client.exchange(input), safeFailure);
  assert.equal(certCalls(failing.observed), 1);
  failing.observed.time += 60_000;
  await assert.rejects(failing.client.exchange(input), safeFailure);
  assert.equal(certCalls(failing.observed), 2);
});

test('parallel cold starts share one JWKS fetch', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { client, observed } = fixture({ request: async (url, options, state) => {
    if (url === TOKEN_URL) return { id_token: state.token };
    await wait;
    return { keys: state.keys };
  } });
  const exchanges = Array.from({ length: 4 }, () => client.exchange(input));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(certCalls(observed), 1);
  release();
  assert.equal((await Promise.all(exchanges)).length, 4);
});

test('parallel unknown-key refreshes share one fetch and failed rotation preserves the valid cached key', async () => {
  let release;
  let refreshWait;
  let failRefresh = false;
  const { client, observed } = fixture({ request: async (url, options, state) => {
    if (url === TOKEN_URL) return { id_token: state.token };
    if (refreshWait) await refreshWait;
    if (failRefresh) throw new Error('upstream-sensitive');
    return { keys: state.keys };
  } });
  await client.exchange(input);
  observed.time += 60_000;
  observed.token = signedToken(claims(), { key: secondKey, header: { kid: 'second-key' } });
  observed.keys = [jwk(secondKey, 'second-key')];
  refreshWait = new Promise((resolve) => { release = resolve; });
  const exchanges = Array.from({ length: 4 }, () => client.exchange(input));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(certCalls(observed), 2);
  release();
  await Promise.all(exchanges);

  observed.time += 60_000;
  failRefresh = true;
  observed.token = signedToken(claims(), { header: { kid: 'third-key' } });
  await assert.rejects(client.exchange(input), safeFailure);
  await assert.rejects(client.exchange(input), safeFailure);
  assert.equal(certCalls(observed), 3);
  observed.token = signedToken(claims(), { key: secondKey, header: { kid: 'second-key' } });
  assert.equal((await client.exchange(input)).sub, 'google-subject-123');
  assert.equal(certCalls(observed), 3);
});

test('invalid client configuration is redacted while explicit loopback callback URLs are supported', () => {
  for (const extra of [{ clientId: '' }, { clientSecret: 'fixture-client-secret\n' }, { redirectUri: 'http://studio.example/callback' }, { redirectUri: 'https://@studio.example/callback' }, { redirectUri: 'https://studio.example/callback#fragment' }]) {
    assert.throws(() => createGoogleClient({ ...settings, ...extra }), (failure) => {
      assert.equal(failure.code, 'GOOGLE_AUTH_CONFIGURATION');
      assert.equal(failure.status, 500);
      assert.doesNotMatch(failure.message, /fixture-client-secret|https?:/);
      return true;
    });
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const client = createGoogleClient({ ...settings, redirectUri: `http://${host}:8080/auth/google/callback` });
    assert.equal(typeof client.authorizationUrl({ state: 'state', nonce: input.nonce, codeVerifier: input.codeVerifier }), 'string');
  }
});

test('missing tokens, malformed key sets and injected transport failures are safely redacted', async () => {
  const responses = [null, {}, { id_token: 'upstream-sensitive' }, { error: 'fixture-client-secret' }];
  for (const response of responses) await assert.rejects(fixture({ request: async () => response }).client.exchange(input), safeFailure);
  for (const keys of [[], null, [null], Array.from({ length: 65 }, () => jwk())]) {
    await assert.rejects(fixture({ keys }).client.exchange(input), safeFailure);
  }
  await assert.rejects(fixture({ request: async () => { throw new Error('upstream-sensitive fixture-client-secret fixture-oauth-code'); } }).client.exchange(input), safeFailure);
});

function nativeTransport(t, { addresses = [{ address: '93.184.216.34', family: 4 }], statusCode = 200, chunks, headers = {}, event, hang = false, interrupt = false, slowBody = false } = {}) {
  const observed = { calls: [], destroyed: 0 };
  t.mock.method(dns, 'lookup', async (hostname, options) => {
    observed.dns = { hostname, options };
    return addresses;
  });
  t.mock.method(https, 'request', (url, options, callback) => {
    const call = { url: String(url), options };
    observed.calls.push(call);
    const req = new EventEmitter();
    req.destroy = () => { observed.destroyed++; return req; };
    req.end = (body) => {
      call.body = body;
      queueMicrotask(() => {
        if (event) {
          observed.socket = new PassThrough();
          if (event === 'error') req.emit(event, new Error('upstream-sensitive fixture-client-secret'));
          else req.emit(event, { statusCode: 101 }, observed.socket, Buffer.alloc(0));
          return;
        }
        if (hang) return;
        const res = new PassThrough();
        observed.response = res;
        res.statusCode = statusCode; res.headers = headers;
        callback(res);
        const json = String(url) === TOKEN_URL ? { id_token: signedToken() } : { keys: [jwk()] };
        for (const chunk of chunks ?? [JSON.stringify(json)]) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        if (interrupt) res.destroy();
        else if (!res.destroyed && !slowBody) res.end();
      });
    };
    return req;
  });
  const client = createGoogleClient(settings, { now: () => INITIAL_TIME });
  return { client, observed };
}

test('native transport uses fixed HTTPS endpoints, IPv4 public DNS pinning and no shared proxy agent', async (t) => {
  const { client, observed } = nativeTransport(t);
  assert.deepEqual(await client.exchange(input), { sub: 'google-subject-123', email: 'person@example.com' });
  assert.deepEqual(observed.calls.map((call) => call.url), [TOKEN_URL, JWKS_URL]);
  assert.equal(observed.dns.options.family, 4);
  assert.equal(observed.dns.options.all, true);
  for (const { url, options } of observed.calls) {
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, new URL(url).hostname);
    assert.equal(options.family, 4);
    options.lookup('ignored.example', {}, (failure, address, family) => {
      assert.equal(failure, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
    });
  }
});

test('native transport rejects all private, empty or unexpected-family DNS answers', async (t) => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '2606:4700:4700::1111', family: 6 }]]) {
    await t.test(JSON.stringify(addresses), async (child) => {
      const { client, observed } = nativeTransport(child, { addresses });
      await assert.rejects(client.exchange(input), safeFailure);
      assert.equal(observed.calls.length, 0);
    });
  }
});

test('native transport rejects redirects, oversized or malformed responses and socket failures', async (t) => {
  for (const options of [{ statusCode: 302 }, { chunks: [Buffer.alloc(256 * 1024 + 1, 120)] }, { chunks: ['upstream-sensitive fixture-client-secret'] }, { headers: { 'content-encoding': 'gzip' } }, { event: 'error' }, { event: 'close' }, { event: 'upgrade' }, { interrupt: true }]) {
    await t.test(JSON.stringify(options, (key, value) => key === 'chunks' ? '[omitted]' : value), async (child) => {
      const { client, observed } = nativeTransport(child, options);
      await assert.rejects(client.exchange(input), safeFailure);
      assert.equal(observed.calls.length, 1);
      assert(observed.destroyed > 0);
      if (options.event === 'upgrade') assert.equal(observed.socket.destroyed, true);
    });
  }
});

test('slow response bodies share the same deadline and are destroyed on timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, observed } = nativeTransport(t, { chunks: ['{"id_token":"'], slowBody: true });
  const result = client.exchange(input);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  await assert.rejects(result, safeFailure);
  assert.equal(observed.response.destroyed, true);
  assert(observed.destroyed > 0);
});

test('10 second deadline includes DNS and late answers cannot start HTTPS', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, observed } = nativeTransport(t);
  let resolveDns;
  t.mock.method(dns, 'lookup', () => new Promise((resolve) => { resolveDns = resolve; }));
  const result = client.exchange(input);
  t.mock.timers.tick(10_000);
  await assert.rejects(result, safeFailure);
  resolveDns([{ address: '93.184.216.34', family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.calls.length, 0);
});

test('10 second deadline closes hanging HTTP and aborts injected transports too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, observed } = nativeTransport(t, { hang: true });
  const result = client.exchange(input);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  await assert.rejects(result, safeFailure);
  assert(observed.destroyed > 0);
  const injected = fixture({ request: () => new Promise(() => {}) });
  const pending = injected.client.exchange(input);
  t.mock.timers.tick(10_000);
  await assert.rejects(pending, safeFailure);
  assert.equal(injected.observed.calls[0].signal.aborted, true);
});
