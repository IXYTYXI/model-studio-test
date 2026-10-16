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
  const app=await createApp(config,{chatHeartbeatMs:options.chatHeartbeatMs,providerCaller:options.providerCaller|| (async (provider,messages)=>{calls.push({provider,messages});return {text:'A real adapter would return this fixture reply',usage:{inputTokens:10,outputTokens:8}};})});
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

async function prepareLongChat(f){
 const session=await f.login();
 const r=await f.request('/api/admin/providers/openai',{method:'PUT',session,body:{baseUrl:'https://api.openai.com/v1',model:'test-model',protocol:'openai-responses',apiKey:'fixture-long',enabled:true,maxOutputTokens:65536}});
 assert.equal(r.status,200);
 const conversation=(await f.request('/api/conversations',{method:'POST',session,body:{provider:'openai'}})).json.conversation;
 return {session,body:{conversationId:conversation.id,message:'Long reply'}};
}
test('long chat survives an idle-timeout proxy, forwards budget/deadline and stores one reply',async t=>{
 let observed;const f=await fixture(t,{chatHeartbeatMs:50,config:{providerTimeoutMs:900000},providerCaller:async(p,m,o)=>{observed={p,o};await new Promise(r=>setTimeout(r,1200));return {text:'Long completed reply'};}});
 const {session,body}=await prepareLongChat(f);
 const proxy=http.createServer((req,res)=>{
  const upstream=http.request(f.base+req.url,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  upstream.setTimeout(500,()=>upstream.destroy(new Error('proxy idle timeout')));
  upstream.on('error',()=>res.destroy());req.pipe(upstream);
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{proxy.closeAllConnections();proxy.close(r);}));
 const result=await fetch(`http://127.0.0.1:${proxy.address().port}/api/chat`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:session.cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
 const raw=await result.text();assert.match(raw,/^ \n/);assert.equal(result.headers.get('x-accel-buffering'),'no');
 assert.equal(JSON.parse(raw).messages.at(-1).content,'Long completed reply');assert.equal(observed.p.maxOutputTokens,65536);assert.equal(observed.o.timeoutMs,900000);
 assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM messages').get().n,2);
});
test('timeout after heartbeat is a structured safe error and does not store an answer',async t=>{
 const f=await fixture(t,{chatHeartbeatMs:10,providerCaller:async()=>{await new Promise(r=>setTimeout(r,80));throw Object.assign(new Error('secret upstream text'),{code:'PROVIDER_TIMEOUT'});}});
 const {session,body}=await prepareLongChat(f);const r=await f.request('/api/chat',{method:'POST',session,body});
 assert.equal(r.status,200);assert.equal(r.json.error.status,504);assert.equal(r.json.error.code,'PROVIDER_TIMEOUT');assert.doesNotMatch(JSON.stringify(r.json),/secret upstream/);
 assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM messages').get().n,0);
});
test('session revoked during a heartbeat response never receives or saves the answer',async t=>{
 let resolve;const f=await fixture(t,{chatHeartbeatMs:10,providerCaller:()=>new Promise(r=>resolve=r)});const {session,body}=await prepareLongChat(f);
 const response=await fetch(f.base+'/api/chat',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:session.cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
 f.app.db.exec('DELETE FROM sessions');resolve({text:'private late reply'});const data=await response.json();
 assert.equal(data.error.status,401);assert.doesNotMatch(JSON.stringify(data),/private late reply/);assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM messages').get().n,0);
});
