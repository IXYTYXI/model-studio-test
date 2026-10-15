import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {hashPassword, verifyPassword, encryptSecret, decryptSecret, validatePassword, RateLimiter} from '../src/security.js';

test('password hashes are salted, verify correctly and never contain password', async () => {
  const pw = 'a-unique-long-password-918';
  const a = await hashPassword(pw); const b = await hashPassword(pw);
  assert.notEqual(a, b); assert.ok(!a.includes(pw));
  assert.equal(await verifyPassword(pw, a), true);
  assert.equal(await verifyPassword('wrong-password', a), false);
  assert.equal(await verifyPassword(pw, 'corrupt'), false);
});
test('weak and overlong passwords are rejected', () => {
  assert.throws(() => validatePassword('short'));
  assert.throws(() => validatePassword('x'.repeat(129)));
  assert.doesNotThrow(() => validatePassword('correct horse battery staple'));
});
test('API keys use authenticated encryption bound to their provider', () => {
  const key = randomBytes(32), value = 'fake-test-key-123456';
  const sealed = encryptSecret(value, key, 'openai');
  assert.ok(!sealed.includes(value));
  assert.equal(decryptSecret(sealed, key, 'openai'), value);
  assert.throws(() => decryptSecret(sealed, key, 'anthropic'));
  assert.throws(() => decryptSecret(sealed, randomBytes(32), 'openai'));
  assert.throws(() => decryptSecret(sealed.slice(0,-3)+'abc', key, 'openai'));
});
test('rate limit bounds attempts and expires without growing unbounded', () => {
  let now=0; const limiter=new RateLimiter({limit:2,windowMs:1000,maxEntries:3,now:()=>now});
  assert.equal(limiter.take('a'),true); assert.equal(limiter.take('a'),true);
  assert.equal(limiter.take('a'),false); now=1001;
  assert.equal(limiter.take('a'),true);
  limiter.take('b');limiter.take('c');assert.equal(limiter.take('d'),false);
});
