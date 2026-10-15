import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { PROVIDER_DEFAULTS } from '../src/providers.js';
import { randomToken, tokenHash } from '../src/security.js';

const origin = 'http://localhost:8080';
const providerSettings = (id, extra = {}) => ({
  ...PROVIDER_DEFAULTS.find((provider) => provider.id === id),
  model: 'test-configured-model', enabled: true, maxOutputTokens: 1024, ...extra,
});

// Real app routes, authentication, encryption and persistent SQLite, with an
// in-memory HTTP boundary and an injected upstream so no model API is called.
async function fixture(t, providerEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-provider-key-test-'));
  const baseEnv = {
    MASTER_KEY: randomBytes(32).toString('hex'), DATA_DIR: dir,
    BOOTSTRAP_PASSWORD: 'provider-key-test-password-2026', PUBLIC_ORIGIN: origin,
  };
  const calls = [];
  let app;
  async function open(env) {
    app = await createApp(readConfig({ ...baseEnv, ...env }), {
      providerCaller: async (provider) => {
        calls.push({ id: provider.id, apiKey: provider.apiKey });
        return { text: 'fixture reply', usage: { inputTokens: 2, outputTokens: 3 } };
      },
    });
  }
  await open(providerEnv);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin = app.db.prepare('SELECT * FROM users WHERE role=?').get('admin');
  function session(userId = admin.id) {
    const token = randomToken(), csrf = randomToken();
    app.db.prepare('INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)')
      .run(tokenHash(token), userId, csrf, Date.now() + 3_600_000);
    return { cookie: `studio_session=${token}`, csrf };
  }
  const adminSession = session();
  function request(path, { method = 'GET', body, auth = adminSession } = {}) {
    return new Promise((resolve) => {
      const req = new PassThrough();
      req.url = path; req.method = method; req.socket = { remoteAddress: '127.0.0.1' };
      req.headers = { origin, 'content-type': 'application/json', ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}) };
      const res = new EventEmitter();
      const responseHeaders = {};
      res.destroyed = false; res.writableEnded = false; res.headersSent = false;
      res.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = value; };
      res.writeHead = (status, headers = {}) => {
        res.statusCode = status; res.headersSent = true;
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      };
      res.end = (data) => { res.writableEnded = true; resolve({ status: res.statusCode, json: JSON.parse(data), headers: responseHeaders }); };
      res.destroy = () => { res.destroyed = true; };
      app.server.emit('request', req, res);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function chat(provider) {
    const created = await request('/api/conversations', { method: 'POST', body: { provider } });
    assert.equal(created.status, 201);
    return request('/api/chat', { method: 'POST', body: { conversationId: created.json.conversation.id, message: 'hello' } });
  }
  return {
    get app() { return app; }, dir, calls, admin, request, chat, session,
    async restart(env = {}) { await app.close(); await open(env); },
  };
}

test('all environment-managed providers enable without stored keys and never expose or store their values', async (t) => {
  const injected = { openai: 'env-only-openai-test-key', anthropic: 'env-only-anthropic-test-key', gemini: 'env-only-gemini-test-key' };
  const f = await fixture(t, { OPENAI_API_KEY: injected.openai, ANTHROPIC_API_KEY: injected.anthropic, GEMINI_API_KEY: injected.gemini });
  const responses = [];
  for (const provider of PROVIDER_DEFAULTS) {
    const saved = await f.request(`/api/admin/providers/${provider.id}`, { method: 'PUT', body: providerSettings(provider.id) });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.provider.hasKey, true);
    assert.equal(saved.json.provider.keySource, 'environment');
    assert.equal(f.app.db.prepare('SELECT secret FROM providers WHERE id=?').get(provider.id).secret, '');
    responses.push(saved, await f.chat(provider.id));
    assert.equal(responses.at(-1).status, 200);
  }
  const session = await f.request('/api/session');
  assert.equal(session.json.providers.every((provider) => provider.configured), true);
  responses.push(session, await f.request('/api/admin/providers'), await f.request('/api/providers'));
  assert.deepEqual(f.calls, PROVIDER_DEFAULTS.map(({ id }) => ({ id, apiKey: injected[id] })));
  f.app.db.exec('PRAGMA wal_checkpoint(FULL)');
  const database = await readFile(join(f.dir, 'studio.sqlite3'));
  for (const value of Object.values(injected)) {
    assert.equal(JSON.stringify(responses).includes(value), false);
    assert.equal(database.includes(Buffer.from(value)), false);
  }
});

test('environment keys override stored keys without changing them and removing the environment restores stored fallback', async (t) => {
  const f = await fixture(t);
  const storedKey = 'previous-stored-test-key';
  assert.equal((await f.request('/api/admin/providers/openai', { method: 'PUT', body: providerSettings('openai', { apiKey: storedKey }) })).status, 200);
  const sealed = f.app.db.prepare('SELECT secret FROM providers WHERE id=?').get('openai').secret;
  await f.restart({ OPENAI_API_KEY: 'injected-override-test-key' });
  const managed = await f.request('/api/admin/providers');
  assert.equal(managed.json.providers.find((provider) => provider.id === 'openai').keySource, 'environment');
  assert.equal((await f.chat('openai')).status, 200);
  assert.equal(f.calls.at(-1).apiKey, 'injected-override-test-key');
  assert.equal(f.app.db.prepare('SELECT secret FROM providers WHERE id=?').get('openai').secret, sealed);
  await f.restart({ OPENAI_API_KEY: '' });
  const fallback = await f.request('/api/admin/providers');
  assert.equal(fallback.json.providers.find((provider) => provider.id === 'openai').keySource, 'stored');
  assert.equal((await f.chat('openai')).status, 200);
  assert.equal(f.calls.at(-1).apiKey, storedKey);
  assert.equal(f.app.db.prepare('SELECT secret FROM providers WHERE id=?').get('openai').secret, sealed);
});

test('managed keys reject replacements while omitted and blank keys still allow ordinary settings updates', async (t) => {
  const f = await fixture(t, { OPENAI_API_KEY: 'managed-test-key' });
  const before = f.app.db.prepare('SELECT * FROM providers WHERE id=?').get('openai');
  for (const apiKey of ['attempted-replacement-test-key', 'bad key value']) {
    const rejected = await f.request('/api/admin/providers/openai', { method: 'PUT', body: providerSettings('openai', { apiKey }) });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.error.code, 'PROVIDER_KEY_MANAGED');
    assert.equal(JSON.stringify(rejected).includes(apiKey), false);
    assert.equal(JSON.stringify(rejected).includes('managed-test-key'), false);
    assert.deepEqual(f.app.db.prepare('SELECT * FROM providers WHERE id=?').get('openai'), before);
  }
  for (const apiKey of [undefined, '']) {
    const saved = await f.request('/api/admin/providers/openai', {
      method: 'PUT', body: providerSettings('openai', { apiKey, model: 'updated-model', protocol: 'openai-chat', enabled: false }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.provider.model, 'updated-model');
    assert.equal(saved.json.provider.protocol, 'openai-chat');
    assert.equal(saved.json.provider.enabled, false);
    assert.equal(saved.json.provider.hasKey, true);
    assert.equal(saved.json.provider.keySource, 'environment');
    assert.equal(f.app.db.prepare('SELECT secret FROM providers WHERE id=?').get('openai').secret, '');
  }
  assert.equal((await f.request('/api/session')).json.providers.find((provider) => provider.id === 'openai').configured, false);
});

test('absent environment keys retain stored-key management and member admin restrictions', async (t) => {
  const f = await fixture(t, { OPENAI_API_KEY: '' });
  const initial = await f.request('/api/admin/providers');
  assert.equal(initial.json.providers.every((provider) => provider.keySource === 'none' && !provider.hasKey), true);
  assert.equal((await f.request('/api/session')).json.providers.every((provider) => !provider.configured), true);
  const saved = await f.request('/api/admin/providers/openai', { method: 'PUT', body: providerSettings('openai', { apiKey: 'ordinary-stored-key' }) });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.provider.keySource, 'stored');
  assert.equal(saved.json.provider.hasKey, true);
  assert.equal((await f.chat('openai')).status, 200);
  assert.equal(f.calls.at(-1).apiKey, 'ordinary-stored-key');
  const memberId = randomUUID();
  f.app.db.prepare('INSERT INTO users(id,username,password,role,daily_limit,created_at) VALUES(?,?,?,?,?,?)')
    .run(memberId, 'member', f.admin.password, 'member', 50, new Date().toISOString());
  const member = f.session(memberId);
  await f.restart({ OPENAI_API_KEY: 'member-inaccessible-env-key' });
  assert.equal((await f.request('/api/admin/providers', { auth: member })).status, 403);
  assert.equal((await f.request('/api/admin/providers/openai', { method: 'PUT', auth: member, body: providerSettings('openai', { apiKey: 'member-attempt' }) })).status, 403);
  const memberSession = await f.request('/api/session', { auth: member });
  assert.equal(memberSession.status, 200);
  assert.equal(JSON.stringify(memberSession).includes('member-inaccessible-env-key'), false);
  assert.equal((await f.request('/api/admin/providers', { auth: null })).status, 401);
});
