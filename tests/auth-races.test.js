import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword, randomToken, tokenHash } from '../src/security.js';

const origin = 'http://localhost:8080';
const initialPassword = 'race-test-original-password-2026';

// These races use the real router, SQLite and scrypt. Only the HTTP transport is
// in-memory, so the checks are deterministic and never bind a port or use a key.
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-auth-races-'));
  const app = await createApp({
    dataDir, masterKey: randomBytes(32), bootstrapUsername: 'admin',
    bootstrapPassword: initialPassword, publicOrigin: origin,
    defaultDailyLimit: 50, globalDailyLimit: 500, allowedHosts: new Set(),
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const admin = app.db.prepare('SELECT * FROM users WHERE username=?').get('admin');

  function session(userId = admin.id) {
    const token = randomToken(), csrf = randomToken();
    app.db.prepare('INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)')
      .run(tokenHash(token), userId, csrf, Date.now() + 3_600_000);
    return { cookie: `studio_session=${token}`, csrf };
  }

  function request(path, { method = 'GET', body, session: auth } = {}) {
    return new Promise((resolve) => {
      const req = new PassThrough();
      req.url = path;
      req.method = method;
      req.socket = { remoteAddress: '127.0.0.1' };
      req.headers = {
        origin, 'content-type': 'application/json',
        ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf } : {}),
      };
      const res = new EventEmitter();
      const responseHeaders = {};
      res.destroyed = false;
      res.writableEnded = false;
      res.headersSent = false;
      res.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = value; };
      res.writeHead = (status, headers = {}) => {
        res.statusCode = status;
        res.headersSent = true;
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      };
      res.end = (data) => {
        res.writableEnded = true;
        resolve({ status: res.statusCode, json: JSON.parse(data), headers: responseHeaders });
      };
      res.destroy = () => { res.destroyed = true; };
      app.server.emit('request', req, res);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  return { app, admin, session, request };
}

// Wait for the actual asynchronous crypto operation, rather than using a delay
// that could accidentally let the hash finish before the competing mutation.
function nextScrypt(t) {
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const hook = createHook({
    init(_id, type) {
      if (type === 'SCRYPTREQUEST') {
        hook.disable();
        signalStarted();
      }
    },
  });
  t.after(() => hook.disable());
  hook.enable();
  return started;
}

test('a login verifying the old password cannot create a session after a password reset', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const newPassword = 'race-test-recovered-password-2026';
  const nextHash = await hashPassword(newPassword);
  f.session();
  const hashing = nextScrypt(t);
  const login = f.request('/api/login', { method: 'POST', body: { username: 'admin', password: initialPassword } });
  await hashing;

  // Commit exactly the password-reset writes while the old-password check is
  // pending. The reset route itself is covered by app.test.js.
  f.app.db.exec('BEGIN IMMEDIATE');
  f.app.db.prepare('UPDATE users SET password=? WHERE id=?').run(nextHash, f.admin.id);
  f.app.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.admin.id);
  f.app.db.exec('COMMIT');

  const rejected = await login;
  assert.equal(rejected.status, 401);
  assert.equal(rejected.json.error.code, 'INVALID_CREDENTIALS');
  assert.equal(rejected.headers['set-cookie'], undefined);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(f.admin.id).n, 0);
  const freshLogin = await f.request('/api/login', { method: 'POST', body: { username: 'admin', password: newPassword } });
  assert.equal(freshLogin.status, 200);
  assert.match(freshLogin.headers['set-cookie'], /^studio_session=/);
});

test('a pending admin password reset preserves a concurrent account disable and quota update', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const targetId = randomUUID();
  f.app.db.prepare('INSERT INTO users(id,username,password,role,daily_limit,created_at) VALUES(?,?,?,?,?,?)')
    .run(targetId, 'member', f.admin.password, 'member', 50, new Date().toISOString());
  const adminSession = f.session();
  f.session(targetId);
  const nextPassword = 'race-test-member-new-password-2026';
  const hashing = nextScrypt(t);
  const reset = f.request(`/api/admin/users/${targetId}`, {
    method: 'PATCH', session: adminSession, body: { password: nextPassword },
  });
  await hashing;
  const disabled = await f.request(`/api/admin/users/${targetId}`, {
    method: 'PATCH', session: adminSession, body: { enabled: false, dailyLimit: 7 },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.user.enabled, false);

  const completed = await reset;
  assert.equal(completed.status, 200);
  assert.equal(completed.json.user.enabled, false);
  assert.equal(completed.json.user.dailyLimit, 7);
  const stored = f.app.db.prepare('SELECT enabled,daily_limit,password FROM users WHERE id=?').get(targetId);
  assert.equal(stored.enabled, 0);
  assert.equal(stored.daily_limit, 7);
  assert.equal(await verifyPassword(nextPassword, stored.password), true);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(targetId).n, 0);
});
