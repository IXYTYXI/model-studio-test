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
test('upgrading the old schema preserves members and history without restoring revoked shared access',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'studio-upgrade-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const config={dataDir,masterKey:randomBytes(32),bootstrapUsername:'admin',bootstrapPassword:'first-password-long-2026',defaultDailyLimit:50};
  let db=await openStore(config,PROVIDER_DEFAULTS);
  db.prepare('INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,?,?)').run('legacy-member','legacy','legacy-hash','member','2026-10-14');
  db.prepare('INSERT INTO conversations(id,user_id,provider,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('legacy-chat','legacy-member','openai','Existing history','2026-10-14','2026-10-14');
  db.exec('DROP TABLE personal_providers; DROP TABLE google_accounts; ALTER TABLE users DROP COLUMN allow_shared_keys;');db.close();
  db=await openStore({...config,bootstrapPassword:undefined},PROVIDER_DEFAULTS);
  assert.equal(db.prepare('SELECT allow_shared_keys FROM users WHERE id=?').get('legacy-member').allow_shared_keys,1);
  assert.equal(db.prepare('SELECT title FROM conversations WHERE id=?').get('legacy-chat').title,'Existing history');
  assert.equal(db.prepare('SELECT count(*) AS n FROM google_accounts').get().n,0);
  db.prepare('UPDATE users SET allow_shared_keys=0 WHERE id=?').run('legacy-member');db.close();
  db=await openStore(config,PROVIDER_DEFAULTS);
  assert.equal(db.prepare('SELECT allow_shared_keys FROM users WHERE id=?').get('legacy-member').allow_shared_keys,0);
  assert.equal(db.prepare('SELECT password FROM users WHERE id=?').get('legacy-member').password,'legacy-hash');db.close();
});

test('generation timeout defaults to five minutes and is operator-configurable',()=>{
 const env={MASTER_KEY:randomBytes(32).toString('hex')};
 assert.equal(readConfig(env).providerTimeoutMs,300000);
 assert.equal(readConfig({...env,PROVIDER_TIMEOUT_SECONDS:'900'}).providerTimeoutMs,900000);
 for(const value of ['0','9','1801','abc','20.5'])assert.throws(()=>readConfig({...env,PROVIDER_TIMEOUT_SECONDS:value}));
});
test('new provider budgets default to 8192 and saved budgets survive reopening',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'studio-output-default-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const cfg={dataDir,masterKey:randomBytes(32),bootstrapUsername:'admin',bootstrapPassword:'fixture-output-password',defaultDailyLimit:50};
 let db=await openStore(cfg,PROVIDER_DEFAULTS);assert.equal(db.prepare('SELECT max_output FROM providers LIMIT 1').get().max_output,8192);
 db.prepare('UPDATE providers SET max_output=2048 WHERE id=?').run('openai');db.close();db=await openStore(cfg,PROVIDER_DEFAULTS);
 assert.equal(db.prepare('SELECT max_output FROM providers WHERE id=?').get('openai').max_output,2048);db.close();
});
