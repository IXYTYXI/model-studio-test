import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/config.js';
import {openStore} from '../src/store.js';
import {PROVIDER_DEFAULTS} from '../src/providers.js';
import {verifyPassword} from '../src/security.js';

test('production config requires a master key and HTTPS origin and exact upstream hosts',()=>{
  assert.throws(()=>readConfig({}));
  const env={MASTER_KEY:randomBytes(32).toString('hex')};
  assert.throws(()=>readConfig({...env,PUBLIC_ORIGIN:'http://public.example'}));
  assert.throws(()=>readConfig({...env,PUBLIC_ORIGIN:'https://example.com/path'}));
  assert.throws(()=>readConfig({...env,ALLOWED_API_HOSTS:'*.example.com'}));
  assert.throws(()=>readConfig({...env,GLOBAL_DAILY_LIMIT:'0'}));
  assert.equal(readConfig({...env,PUBLIC_ORIGIN:'https://studio.example',ALLOWED_API_HOSTS:'gateway.example.com'}).allowedHosts.has('gateway.example.com'),true);
});
test('environment API keys map to their providers and absent or empty values preserve stored-key fallback',()=>{
  const env={MASTER_KEY:randomBytes(32).toString('hex')};
  assert.deepEqual(readConfig(env).providerKeys,{});
  assert.deepEqual(readConfig({...env,OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',GEMINI_API_KEY:''}).providerKeys,{});
  assert.deepEqual(readConfig({...env,OPENAI_API_KEY:'env-openai-example',ANTHROPIC_API_KEY:'env-anthropic-example',GEMINI_API_KEY:'env-gemini-example'}).providerKeys,
    {openai:'env-openai-example',anthropic:'env-anthropic-example',gemini:'env-gemini-example'});
  assert.equal(readConfig({...env,OPENAI_API_KEY:'a'.repeat(8192)}).providerKeys.openai.length,8192);
});
test('invalid environment API keys fail startup without including any key value',()=>{
  const env={MASTER_KEY:randomBytes(32).toString('hex')};
  const invalid=['secret marker','secret\nmarker','secret\tmarker','secret\u0000marker','secret\u007fmarker','secret密钥marker','x'.repeat(8193),null,42];
  for(const name of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'])for(const value of invalid) {
    assert.throws(()=>readConfig({...env,[name]:value}),error=>{
      assert.equal(error instanceof Error,true);
      assert.doesNotMatch(error.message,/secret|marker|密钥|xxxxx/);
      return true;
    },`${name} must reject a malformed key`);
  }
});
test('reopening stored data retains accounts and fails closed with a different master key',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'studio-store-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const config={dataDir,masterKey:randomBytes(32),bootstrapUsername:'admin',bootstrapPassword:'first-password-long-2026',defaultDailyLimit:50};
  let db=await openStore(config,PROVIDER_DEFAULTS);
  const original=db.prepare('SELECT * FROM users').get();db.close();
  db=await openStore({...config,bootstrapPassword:'different-bootstrap-password'},PROVIDER_DEFAULTS);
  assert.equal(db.prepare('SELECT * FROM users').get().id,original.id);
  assert.equal(await verifyPassword('first-password-long-2026',db.prepare('SELECT * FROM users').get().password),true);
  db.close();
  await assert.rejects(openStore({...config,masterKey:randomBytes(32)},PROVIDER_DEFAULTS));
});
