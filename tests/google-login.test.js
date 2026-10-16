import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../src/app.js';
import {readConfig} from '../src/config.js';

async function fixture(t,{enabled=true,email='owner@example.com',sub='google-sub-1',withProvider=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'studio-google-login-'));
  const calls=[],providerCalls=[];
  let identity={sub,email},failure=false,release=null,time=Date.now();
  const client={authorizationUrl(input){calls.push({kind:'start',...input});return 'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({state:input.state});},
    async exchange(input){calls.push({kind:'exchange',...input});if(release)await new Promise(resolve=>{release.resolve=resolve;});if(failure)throw new Error('secret-provider-error');return identity;}};
  const config=readConfig({MASTER_KEY:randomBytes(32).toString('hex'),DATA_DIR:dir,BOOTSTRAP_USERNAME:email,BOOTSTRAP_PASSWORD:'initial-password-2026',PUBLIC_ORIGIN:'https://studio.example',
    ...(withProvider?{OPENAI_API_KEY:'fixture-provider-key'}:{}),
    ...(enabled?{GOOGLE_CLIENT_ID:'1234-test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'google-client-secret-fixture'}:{})});
  const app=await createApp(config,{googleClient:client,googleNow:()=>time,providerCaller:async()=>{providerCalls.push(true);return {text:'fixture reply'};}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{app.server.closeAllConnections();await app.close();await rm(dir,{recursive:true,force:true});});
  async function request(path,{method='GET',body,cookie,csrf,origin='https://studio.example'}={}) {
    const res=await fetch(base+path,{method,redirect:'manual',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await res.text();return {status:res.status,headers:res.headers,text,json:text?JSON.parse(text):null};
  }
  async function start(){const res=await request('/api/auth/google/start',{method:'POST',body:{}});assert.equal(res.status,200);const state=new URL(res.json.url).searchParams.get('state');return {state,cookie:res.headers.getSetCookie()[0].split(';')[0],headers:res.headers};}
  const callback=(flow,params='code=fixture-code')=>request(`/api/auth/google/callback?state=${flow.state}&${params}`,{cookie:flow.cookie});
  return {app,request,start,callback,calls,providerCalls,setIdentity(value){identity=value;},setFailure(){failure=true;},delay(){release={};return release;},advance(ms){time+=ms;}};
}
const sessionCookie=res=>res.headers.getSetCookie().find(value=>value.startsWith('__Host-studio_session='))?.split(';')[0];

test('Google config is optional, fail-closed, and does not expose its secret',async t=>{
  const f=await fixture(t,{enabled:false});
  assert.deepEqual((await f.request('/api/auth/config')).json,{google:{enabled:false}});
  assert.equal((await f.request('/api/auth/google/start',{method:'POST',body:{}})).status,404);
  assert.equal(f.calls.length,0);
  assert.throws(()=>readConfig({MASTER_KEY:'a'.repeat(64),GOOGLE_CLIENT_ID:'123.apps.googleusercontent.com'}));
  assert.throws(()=>readConfig({MASTER_KEY:'a'.repeat(64),GOOGLE_CLIENT_SECRET:'never-print-this-secret'}),error=>!error.message.includes('never-print'));
});
test('Google state is browser-bound, single-use and creates only an ordinary member without email account takeover',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.request('/api/auth/config')).json,{google:{enabled:true}});
  assert.equal((await f.request('/api/auth/google/start',{method:'POST',body:{},origin:'https://evil.example'})).status,403);
  const flow=await f.start();
  assert.match(flow.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  assert.match(flow.headers.get('set-cookie'),/Secure/);
  assert.match(flow.headers.get('set-cookie'),/^__Host-studio_google_flow=.*; Path=\//);
  assert.ok(!flow.headers.get('set-cookie').includes('Domain='));
  assert.ok(!JSON.stringify(flow).includes('google-client-secret-fixture'));
  const forged=await f.request(`/api/auth/google/callback?state=${flow.state}&code=fixture-code`);
  assert.equal(forged.headers.get('location'),'/login?google_error=failed');assert.equal(f.calls.filter(c=>c.kind==='exchange').length,0);
  const tossed=await f.callback({...flow,cookie:flow.cookie.replace('__Host-studio_google_flow=','studio_google_flow=')});
  assert.equal(tossed.headers.get('location'),'/login?google_error=failed');assert.equal(f.calls.filter(c=>c.kind==='exchange').length,0);
  const other=await f.start();
  const mismatched=await f.callback({...flow,cookie:other.cookie});
  assert.equal(mismatched.headers.get('location'),'/login?google_error=failed');assert.equal(f.calls.filter(c=>c.kind==='exchange').length,0);
  assert.equal((await f.callback({...flow,cookie:flow.cookie+'; '+other.cookie})).headers.get('location'),'/login?google_error=failed');
  const result=await f.callback(flow);assert.equal(result.status,303);assert.equal(result.headers.get('location'),'/codex');
  assert.ok(sessionCookie(result));
  assert.match(result.headers.getSetCookie().find(value=>value.startsWith('__Host-studio_session=')),/Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  assert.equal((await f.request('/api/session',{cookie:sessionCookie(result).replace('__Host-studio_session=','studio_session=')})).status,401);
  const session=await f.request('/api/session',{cookie:sessionCookie(result)});
  assert.equal(session.json.user.role,'member');assert.equal(session.json.user.email,'owner@example.com');assert.equal(session.json.user.passwordEnabled,false);assert.equal(session.json.user.allowSharedKeys,false);
  assert.notEqual(session.json.user.username,'owner@example.com');assert.equal(session.json.user.dailyLimit,50);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM users').get().n,2);
  assert.equal(f.app.db.prepare('SELECT role FROM users WHERE username=?').get('owner@example.com').role,'admin');
  const replay=await f.callback(flow);assert.equal(replay.headers.get('location'),'/login?google_error=failed');assert.equal(sessionCookie(replay),undefined);
  assert.equal(f.calls.filter(c=>c.kind==='exchange').length,1);
  const start=f.calls.find(c=>c.kind==='start'),exchange=f.calls.find(c=>c.kind==='exchange');
  assert.equal(exchange.nonce,start.nonce);assert.equal(exchange.codeVerifier,start.codeVerifier);
  assert.ok(!JSON.stringify(session.json).includes('google-sub-1'));
});
test('Google subject remains the account identity while email changes, and disabled members cannot log in',async t=>{
  const f=await fixture(t);let result=await f.callback(await f.start());
  const first=(await f.request('/api/session',{cookie:sessionCookie(result)})).json.user;
  f.setIdentity({sub:'google-sub-1',email:'renamed@example.com'});result=await f.callback(await f.start());
  const second=(await f.request('/api/session',{cookie:sessionCookie(result)})).json.user;
  assert.equal(first.id,second.id);assert.equal(second.email,'renamed@example.com');
  f.app.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(first.id);
  result=await f.callback(await f.start());assert.equal(result.headers.get('location'),'/login?google_error=disabled');assert.equal(sessionCookie(result),undefined);
  assert.equal((await f.request('/api/session',{cookie:sessionCookie(result)})).status,401);
});
test('OAuth cancellation, malformed callbacks and provider failures use fixed clean redirects',async t=>{
  const f=await fixture(t);
  const cancelled=await f.callback(await f.start(),'error=access_denied&error_description=secret-upstream-text');
  assert.equal(cancelled.headers.get('location'),'/login?google_error=cancelled');assert.equal(f.calls.filter(c=>c.kind==='exchange').length,0);
  const duplicate=await f.callback(await f.start(),'code=a&code=b');assert.equal(duplicate.headers.get('location'),'/login?google_error=failed');
  const missing=await f.callback(await f.start(),'scope=openid');assert.equal(missing.headers.get('location'),'/login?google_error=failed');
  f.setFailure();const failed=await f.callback(await f.start());assert.equal(failed.headers.get('location'),'/login?google_error=failed');
  assert.ok(!JSON.stringify(failed).includes('secret-provider-error'));assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
});
test('Google registration respects the existing account cap and leaves no partial account',async t=>{
  const f=await fixture(t);
  for(let i=0;i<99;i++)f.app.db.prepare('INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,?,?)').run(`cap-${i}`,`cap-${i}`,'!disabled','member',new Date().toISOString());
  const result=await f.callback(await f.start());assert.equal(result.headers.get('location'),'/login?google_error=capacity');
  assert.equal(sessionCookie(result),undefined);assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM users').get().n,100);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM google_accounts').get().n,0);
});
test('an account disabled while Google is verifying cannot obtain a new session',{timeout:10000},async t=>{
  const f=await fixture(t);const first=await f.callback(await f.start());const user=(await f.request('/api/session',{cookie:sessionCookie(first)})).json.user;
  const delayed=f.delay(),flow=await f.start(),pending=f.callback(flow);
  while(!delayed.resolve)await new Promise(resolve=>setTimeout(resolve,2));
  f.app.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(user.id);delayed.resolve();
  const result=await pending;assert.equal(result.headers.get('location'),'/login?google_error=disabled');assert.equal(sessionCookie(result),undefined);
});
test('expired flows fail before exchange, and Google starts are rate limited',async t=>{
  const f=await fixture(t),expired=await f.start();f.advance(600000);
  assert.equal((await f.callback(expired)).headers.get('location'),'/login?google_error=failed');
  assert.equal(f.calls.filter(c=>c.kind==='exchange').length,0);
  for(let i=0;i<15;i++)await f.start();
  const limited=await f.request('/api/auth/google/start',{method:'POST',body:{}});
  assert.equal(limited.status,429);assert.equal(limited.headers.getSetCookie().length,0);
  f.advance(600000);await f.start();
});
test('Google-only members cannot use admin APIs or a password until an admin sets one',async t=>{
  const f=await fixture(t),result=await f.callback(await f.start()),memberCookie=sessionCookie(result);
  const member=(await f.request('/api/session',{cookie:memberCookie})).json;
  assert.equal((await f.request('/api/admin/users',{cookie:memberCookie})).status,403);
  assert.equal((await f.request('/api/login',{method:'POST',body:{username:member.user.username,password:'!google-only'}})).status,401);
  const admin=await f.request('/api/login',{method:'POST',body:{username:'owner@example.com',password:'initial-password-2026'}});
  const password='new-member-password-2026';
  const reset=await f.request(`/api/admin/users/${member.user.id}`,{method:'PATCH',cookie:sessionCookie(admin),csrf:admin.json.csrfToken,body:{password}});
  assert.equal(reset.status,200);assert.equal(reset.json.user.passwordEnabled,true);
  assert.equal((await f.request('/api/session',{cookie:memberCookie})).status,401);
  const local=await f.request('/api/login',{method:'POST',body:{username:member.user.username,password}});
  assert.equal(local.status,200);assert.equal(local.json.user.id,member.user.id);assert.equal(local.json.user.role,'member');
  const googleAgain=await f.callback(await f.start());
  assert.equal((await f.request('/api/session',{cookie:sessionCookie(googleAgain)})).json.user.id,member.user.id);
});
test('Google members obey the existing daily user and site quotas before any provider call',async t=>{
  const f=await fixture(t,{withProvider:true}),login=await f.callback(await f.start()),cookie=sessionCookie(login);
  const session=(await f.request('/api/session',{cookie})).json,csrf=session.csrfToken,user=session.user;
  f.app.db.prepare('UPDATE users SET allow_shared_keys=1 WHERE id=?').run(user.id);
  const admin=f.app.db.prepare('SELECT id FROM users WHERE role=?').get('admin');
  f.app.db.prepare('UPDATE providers SET enabled=1,model=? WHERE id=?').run('fixture-model','openai');
  f.app.db.prepare('INSERT INTO usage(user_id,day,used) VALUES(?,?,?)').run(user.id,session.usage.day,49);
  const otherMember=randomUUID();
  f.app.db.prepare('INSERT INTO users(id,username,password,role,daily_limit,created_at) SELECT ?,?,password,?,?,created_at FROM users WHERE id=?').run(otherMember,'other-quota-member','member',500,admin.id);
  f.app.db.prepare('INSERT INTO usage(user_id,day,used) VALUES(?,?,?)').run(otherMember,session.usage.day,449);
  f.app.db.prepare('INSERT INTO usage(user_id,day,used) VALUES(?,?,?)').run(admin.id,session.usage.day,9000);
  const created=await f.request('/api/conversations',{method:'POST',cookie,csrf,body:{provider:'openai'}});
  assert.equal(created.status,201);
  const chat=()=>f.request('/api/chat',{method:'POST',cookie,csrf,body:{conversationId:created.json.conversation.id,message:'hello'}});
  const fiftieth=await chat();assert.equal(fiftieth.status,200);assert.equal(fiftieth.json.usage.used,50);
  const userLimited=await chat();assert.equal(userLimited.status,429);assert.equal(userLimited.json.error.code,'DAILY_LIMIT');assert.equal(f.providerCalls.length,1);
  f.app.db.prepare('UPDATE users SET daily_limit=100 WHERE id=?').run(user.id);
  assert.equal((await chat()).status,200);
  const siteLimited=await chat();assert.equal(siteLimited.status,429);assert.equal(siteLimited.json.error.code,'DAILY_LIMIT');assert.equal(f.providerCalls.length,2);
});
