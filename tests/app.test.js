import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import {createApp} from '../src/app.js';

const origin='http://localhost:8080',password='local-test-password-2026';
async function fixture(t,options={}) {
  const dir=await mkdtemp(join(tmpdir(),'model-studio-test-'));
  const config={dataDir:dir,masterKey:randomBytes(32),bootstrapUsername:'admin',bootstrapPassword:password,
    publicOrigin:origin,defaultDailyLimit:50,globalDailyLimit:1000,allowedHosts:new Set(['api.openai.com','api.anthropic.com','generativelanguage.googleapis.com']),...options.config};
  const calls=[];
  const app=await createApp(config,{providerCaller:options.providerCaller|| (async (provider,messages)=>{calls.push({provider,messages});return {text:'A real adapter would return this fixture reply',usage:{inputTokens:10,outputTokens:8}};})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  async function request(path,{method='GET',body,session,originHeader=origin,headers={}}={}) {
    const response=await fetch(base+path,{method,headers:{Origin:originHeader,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();let json;try{json=JSON.parse(text);}catch{json={text};}
    return {status:response.status,headers:response.headers,json};
  }
  async function login(username='admin',pw=password) {
    const r=await request('/api/login',{method:'POST',body:{username,password:pw}});
    assert.equal(r.status,200,JSON.stringify(r.json));
    return {...r.json,cookie:r.headers.get('set-cookie').split(';')[0]};
  }
  return {app,config,dir,request,login,calls,base};
}
test('anonymous callers cannot access paid APIs, settings or histories',async t=>{
  const f=await fixture(t);
  for(const path of ['/api/session','/api/conversations','/api/admin/providers','/api/admin/users'])assert.equal((await f.request(path)).status,401);
  assert.equal((await f.request('/api/chat',{method:'POST',body:{message:'hi'}})).status,401);
  assert.equal((await f.request('/healthz')).status,200);
  assert.equal(f.calls.length,0);
});
test('login rejects wrong origin, wrong password and sets secure session protections',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/login',{method:'POST',body:{username:'admin',password},originHeader:'https://evil.example'})).status,403);
  assert.equal((await f.request('/api/login',{method:'POST',body:{username:'admin',password:'wrong'}})).status,401);
  const r=await f.request('/api/login',{method:'POST',body:{username:'admin',password}});
  assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Strict/);
  assert.ok(!JSON.stringify(r.json).includes(password));
});
test('state changes require CSRF and same origin; logout invalidates session',async t=>{
  const f=await fixture(t),s=await f.login();
  assert.equal((await f.request('/api/conversations',{method:'POST',session:s,headers:{'X-CSRF-Token':'wrong'},body:{provider:'openai'}})).status,403);
  assert.equal((await f.request('/api/logout',{method:'POST',session:s,body:{},originHeader:'https://evil.example'})).status,403);
  assert.equal((await f.request('/api/logout',{method:'POST',session:s,body:{}})).status,200);
  assert.equal((await f.request('/api/session',{session:s})).status,401);
});
test('keys are encrypted at rest and never returned; empty updates retain key',async t=>{
  const f=await fixture(t),s=await f.login();
  const secret='test-only-upstream-key-391';
  const cfg={baseUrl:'https://api.openai.com/v1',model:'test-model',protocol:'openai-responses',apiKey:secret,enabled:true,maxOutputTokens:1024};
  const r=await f.request('/api/admin/providers/openai',{method:'PUT',session:s,body:cfg});
  assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.provider.hasKey,true);
  assert.ok(!JSON.stringify(r.json).includes(secret));
  assert.notEqual(f.app.db.prepare('SELECT secret FROM providers WHERE id=?').get('openai').secret,secret);
  assert.ok(!JSON.stringify((await f.request('/api/admin/providers',{session:s})).json).includes(secret));
  assert.equal((await f.request('/api/admin/providers/openai',{method:'PUT',session:s,body:{...cfg,apiKey:''}})).status,200);
  const c=await f.request('/api/conversations',{method:'POST',session:s,body:{provider:'openai'}});
  const chat=await f.request('/api/chat',{method:'POST',session:s,body:{conversationId:c.json.conversation.id,message:'hello'}});
  assert.equal(chat.status,200,JSON.stringify(chat.json));assert.equal(f.calls[0].provider.apiKey,secret);
  f.app.db.exec('PRAGMA wal_checkpoint(FULL)');
  assert.ok(!(await readFile(join(f.dir,'studio.sqlite3'))).includes(Buffer.from(secret)));
});
test('member accounts cannot manage keys or read another account conversation',async t=>{
  const f=await fixture(t),admin=await f.login();
  const created=await f.request('/api/admin/users',{method:'POST',session:admin,body:{username:'member',password:'member-password-long-123',dailyLimit:2}});
  assert.equal(created.status,201);
  const member=await f.login('member','member-password-long-123');
  assert.equal((await f.request('/api/admin/providers',{session:member})).status,403);
  const c=(await f.request('/api/conversations',{method:'POST',session:admin,body:{provider:'openai'}})).json.conversation;
  assert.equal((await f.request('/api/conversations/'+c.id,{session:member})).status,404);
  assert.equal((await f.request('/api/conversations/'+c.id,{method:'DELETE',body:{},session:member})).status,404);
  assert.equal((await f.request('/api/chat',{method:'POST',body:{conversationId:c.id,message:'steal'},session:member})).status,404);
  assert.equal((await f.request('/api/admin/users/'+created.json.user.id,{method:'PATCH',body:{enabled:false},session:admin})).status,200);
  assert.equal((await f.request('/api/session',{session:member})).status,401);
});
test('request quotas persist and all callers including admins are limited',async t=>{
  const f=await fixture(t,{config:{defaultDailyLimit:1}}),s=await f.login();
  await f.request('/api/admin/providers/openai',{method:'PUT',session:s,body:{baseUrl:'https://api.openai.com/v1',model:'test-model',protocol:'openai-responses',apiKey:'test-key',enabled:true,maxOutputTokens:1024}});
  const c=(await f.request('/api/conversations',{method:'POST',session:s,body:{provider:'openai'}})).json.conversation;
  assert.equal((await f.request('/api/chat',{method:'POST',session:s,body:{conversationId:c.id,message:'one'}})).status,200);
  assert.equal((await f.request('/api/chat',{method:'POST',session:s,body:{conversationId:c.id,message:'two'}})).status,429);
  assert.equal(f.calls.length,1);assert.equal(f.app.db.prepare('SELECT used FROM usage').get().used,1);
});
test('password change revokes existing sessions and old password',async t=>{
  const f=await fixture(t),s=await f.login(),other=await f.login();
  const r=await f.request('/api/password',{method:'POST',session:s,body:{currentPassword:password,newPassword:'new-password-long-2026'}});
  assert.equal(r.status,200);
  assert.equal((await f.request('/api/session',{session:other})).status,401);
  await f.login('admin','new-password-long-2026');
});
test('provider failures never leak keys or manufacture successful assistant messages',async t=>{
  const f=await fixture(t,{providerCaller:async()=>{throw new Error('UPSTREAM_SECRET_LEAK');}}),s=await f.login();
  await f.request('/api/admin/providers/openai',{method:'PUT',session:s,body:{baseUrl:'https://api.openai.com/v1',model:'test-model',protocol:'openai-responses',apiKey:'test-key',enabled:true,maxOutputTokens:1024}});
  const c=(await f.request('/api/conversations',{method:'POST',session:s,body:{provider:'openai'}})).json.conversation;
  const r=await f.request('/api/chat',{method:'POST',session:s,body:{conversationId:c.id,message:'one'}});
  assert.equal(r.status,502);assert.ok(!JSON.stringify(r.json).includes('UPSTREAM_SECRET_LEAK'));
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM messages').get().n,0);
});
test('sessions with HTTPS origin set Secure and expired sessions fail',async t=>{
  const f=await fixture(t,{config:{publicOrigin:'https://studio.example'}});
  const r=await f.request('/api/login',{method:'POST',originHeader:'https://studio.example',body:{username:'admin',password}});
  assert.match(r.headers.get('set-cookie'),/Secure/);
  f.app.db.exec('UPDATE sessions SET expires=0');
  assert.equal((await f.request('/api/session',{session:{cookie:r.headers.get('set-cookie').split(';')[0],csrfToken:r.json.csrfToken}})).status,401);
});
test('login throttles repeated attempts and does not trust forwarded IP headers',async t=>{
  const f=await fixture(t);
  for(let i=0;i<8;i++)assert.equal((await f.request('/api/login',{method:'POST',body:{username:'admin',password:'wrong'},headers:{'X-Forwarded-For':`1.2.3.${i}`}})).status,401);
  assert.equal((await f.request('/api/login',{method:'POST',body:{username:'admin',password},headers:{'X-Forwarded-For':'8.8.8.8'}})).status,429);
});
test('unconfigured and invalid provider requests never invoke the upstream',async t=>{
  const f=await fixture(t),s=await f.login();
  const c=(await f.request('/api/conversations',{method:'POST',session:s,body:{provider:'openai'}})).json.conversation;
  assert.equal((await f.request('/api/chat',{method:'POST',session:s,body:{conversationId:c.id,message:'test',apiKey:'caller-key',baseUrl:'http://127.0.0.1'}})).status,409);
  assert.equal((await f.request('/api/admin/providers/openai',{method:'PUT',session:s,body:{baseUrl:'https://evil.example/v1',model:'test',enabled:true,apiKey:'test-key'}})).status,400);
  assert.equal(f.calls.length,0);
});
test('concurrent calls from a single account cannot bypass quota or duplicate conversation writes',async t=>{
  let release,started;const waiting=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{providerCaller:async()=>{started();await new Promise(resolve=>{release=resolve;});return {text:'done'};}}),s=await f.login();
  await f.request('/api/admin/providers/openai',{method:'PUT',session:s,body:{baseUrl:'https://api.openai.com/v1',model:'test-model',protocol:'openai-responses',apiKey:'test-key',enabled:true,maxOutputTokens:1024}});
  const c=(await f.request('/api/conversations',{method:'POST',session:s,body:{provider:'openai'}})).json.conversation;
  const first=f.request('/api/chat',{method:'POST',session:s,body:{conversationId:c.id,message:'first'}});
  await waiting;
  try {assert.equal((await f.request('/api/chat',{method:'POST',session:s,body:{conversationId:c.id,message:'second'}})).status,429);}
  finally {release();}
  assert.equal((await first).status,200);assert.equal(f.app.db.prepare('SELECT used FROM usage').get().used,1);
});
test('a password mutation with a delayed body cannot revive a revoked session',async t=>{
  const f=await fixture(t),s=await f.login();
  let pending;
  const accepted=new Promise(resolve=>f.app.server.once('request',resolve));
  const result=new Promise((resolve,reject)=>{
    pending=http.request(f.base+'/api/password',{method:'POST',headers:{Origin:origin,Cookie:s.cookie,'X-CSRF-Token':s.csrfToken,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    pending.on('error',reject);pending.write('{');
  });
  await accepted;
  const reset=await f.request('/api/admin/users/'+s.user.id,{method:'PATCH',session:s,body:{password:'recovery-password-long-2026'}});
  assert.equal(reset.status,200);
  pending.end(JSON.stringify({currentPassword:password,newPassword:'stale-request-password-2026'}).slice(1));
  assert.equal(await result,401);
  await f.login('admin','recovery-password-long-2026');
});
