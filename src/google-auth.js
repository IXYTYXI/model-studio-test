import { createHash, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { createLocalJWKSet, jwtVerify } from '../vendor/jose/dist/webapi/index.js';
import { AppError } from './errors.js';
import { isPublicAddress } from './providers.js';

// Google OIDC protocol and claim validation:
// https://developers.google.com/identity/openid-connect/openid-connect
// Endpoints are constants; ID-token jku/x5u headers are never used for fetching keys.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CACHE_MS = 60 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 60_000;
const failure = () => new AppError(401, 'GOOGLE_AUTH_FAILED', 'Google 登录未能完成，请重新尝试。');
const configurationFailure = () => new AppError(500, 'GOOGLE_AUTH_CONFIGURATION', 'Google 登录配置无效。');
const printable = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
const validVerifier = (value) => typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);

function validRedirectUri(value) {
  if (!printable(value, 2048) || /[\\#]/.test(value)) return false;
  try {
    const url = new URL(value);
    const authority = value.match(/^https?:\/\/([^/]+)(?:\/|$)/)?.[1];
    return Boolean(authority && !authority.includes('@') && !url.username && !url.password && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))));
  } catch { return false; }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(failure()); };
    if (signal.aborted) { reject(failure()); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      () => { signal.removeEventListener('abort', abort); reject(failure()); },
    );
  });
}

async function nativeRequestJson(destination, { method, headers, body, signal }) {
  if ((destination !== TOKEN_URL || method !== 'POST') && (destination !== JWKS_URL || method !== 'GET')) throw failure();
  const url = new URL(destination);
  const answers = await abortable(dns.lookup(url.hostname, { all: true, family: 4, verbatim: true }), signal);
  if (signal.aborted || !Array.isArray(answers) || !answers.length
    || answers.some((answer) => answer?.family !== 4 || isIP(answer.address) !== 4 || !isPublicAddress(answer.address))) throw failure();
  const address = { address: answers[0].address, family: 4 };
  return new Promise((resolve, reject) => {
    let req;
    let res;
    let settled = false;
    let ended = false;
    const finish = (failed, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (failed) {
        res?.destroy();
        req?.destroy();
        reject(failure());
      } else resolve(value);
    };
    const abort = () => finish(true);
    if (signal.aborted) { finish(true); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      req = https.request(url, {
        method, headers: { ...headers, Accept: 'application/json', 'Accept-Encoding': 'identity',
          ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) },
        agent: false, rejectUnauthorized: true, servername: url.hostname, family: 4, autoSelectFamily: false,
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [address]);
          else callback(null, address.address, 4);
        },
      }, (response) => {
        res = response;
        // Keep error listeners through destroy() so late socket errors cannot escape.
        res.on('error', () => finish(true));
        if (settled) { res.destroy(); return; }
        if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300
          || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
          || Number(res.headers['content-length']) > MAX_RESPONSE_BYTES) { finish(true); return; }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { finish(true); return; }
          chunks.push(chunk);
        });
        res.on('aborted', () => finish(true));
        res.on('close', () => { if (!ended) finish(true); });
        res.on('end', () => {
          ended = true;
          if (settled) return;
          try { finish(false, JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
          catch { finish(true); }
        });
      });
      req.on('error', () => finish(true));
      req.on('close', () => { if (!res) finish(true); });
      req.on('upgrade', (_response, socket) => { socket.destroy(); finish(true); });
      req.end(body);
    } catch { finish(true); }
  });
}

function normalizedEmail(value) {
  if (!printable(value, 254)) throw failure();
  const parts = value.split('@');
  if (parts.length !== 2) throw failure();
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.')
    || !domain.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) throw failure();
  return value.toLowerCase();
}

function validateKeySet(jwks) {
  if (!jwks || !Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 64
    || jwks.keys.some((key) => !key || typeof key !== 'object' || Array.isArray(key)
      || key.kty !== 'RSA' || !printable(key.kid, 255) || key.d !== undefined
      || typeof key.n !== 'string' || !/^[A-Za-z0-9_-]{128,1024}$/.test(key.n)
      || typeof key.e !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(key.e))) throw failure();
  return createLocalJWKSet(jwks);
}

/** requestJson is a fixture boundary returning parsed JSON; now returns Unix milliseconds. */
export function createGoogleClient({ clientId, clientSecret, redirectUri } = {}, { requestJson = nativeRequestJson, now = Date.now } = {}) {
  if (!printable(clientId, 512) || !printable(clientSecret, 8192) || !validRedirectUri(redirectUri)
    || typeof requestJson !== 'function' || typeof now !== 'function') throw configurationFailure();
  let cachedKeys;
  let expiresAt = 0;
  let lastRefresh = -Infinity;
  let pendingRefresh;

  async function request(url, options) {
    const controller = new AbortController();
    // One deadline spans DNS, TLS, headers and the entire response body.
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try { return await abortable(requestJson(url, { ...options, signal: controller.signal }), controller.signal); }
    catch { throw failure(); }
    finally { clearTimeout(timer); }
  }

  async function loadKeys(force = false) {
    const time = now();
    if (pendingRefresh) return pendingRefresh;
    if (!force && cachedKeys && time < expiresAt) return cachedKeys;
    if (time - lastRefresh < REFRESH_COOLDOWN_MS) {
      if (cachedKeys && time < expiresAt) return cachedKeys;
      throw failure();
    }
    // Failed attempts also consume the cooldown, preventing refresh storms.
    lastRefresh = time;
    pendingRefresh = (async () => {
      const resolver = validateKeySet(await request(JWKS_URL, { method: 'GET', headers: {} }));
      cachedKeys = resolver;
      expiresAt = now() + CACHE_MS;
      return resolver;
    })();
    try { return await pendingRefresh; }
    finally { pendingRefresh = undefined; }
  }

  async function resolveKey(header, token) {
    if (header.alg !== 'RS256' || !printable(header.kid, 255)) throw failure();
    let keys = await loadKeys();
    try { return await keys(header, token); }
    catch (error) {
      if (error?.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw failure();
      keys = await loadKeys(true);
      return keys(header, token);
    }
  }

  return Object.freeze({
    authorizationUrl({ state, nonce, codeVerifier } = {}) {
      if (!printable(state, 512) || !printable(nonce, 512) || !validVerifier(codeVerifier)) throw failure();
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email',
        prompt: 'select_account', state, nonce,
        code_challenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'), code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async exchange({ code, nonce, codeVerifier } = {}) {
      try {
        if (!printable(code, 8192) || !printable(nonce, 512) || !validVerifier(codeVerifier)) throw failure();
        const response = await request(TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
            grant_type: 'authorization_code', code, code_verifier: codeVerifier }).toString(),
        });
        if (!response || typeof response.id_token !== 'string' || response.id_token.length > 65_536) throw failure();
        const { payload } = await jwtVerify(response.id_token, resolveKey, {
          algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId,
          requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'],
          currentDate: new Date(now()), clockTolerance: 0,
        });
        const seconds = Math.floor(now() / 1000);
        if (![payload.iat, payload.exp, ...(payload.nbf === undefined ? [] : [payload.nbf])]
          .every((date) => Number.isSafeInteger(date) && date >= 0)
          // Key retrieval is asynchronous; recheck validity at completion too.
          || payload.iat > seconds || payload.exp <= seconds || payload.exp <= payload.iat
          || (payload.nbf !== undefined && payload.nbf > seconds)
          || !(payload.aud === clientId || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === clientId))
          || (Object.hasOwn(payload, 'azp') && payload.azp !== clientId)
          || !printable(payload.sub, 255) || !printable(payload.nonce, 512) || payload.email_verified !== true) throw failure();
        const expectedNonce = Buffer.from(nonce);
        const actualNonce = Buffer.from(payload.nonce);
        if (expectedNonce.length !== actualNonce.length || !timingSafeEqual(expectedNonce, actualNonce)) throw failure();
        return { sub: payload.sub, email: normalizedEmail(payload.email) };
      } catch { throw failure(); }
    },
  });
}
