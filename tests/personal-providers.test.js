import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {randomToken,tokenHash,decryptSecret} from '../src/security.js';

const origin='http://localhost:8080';
const settings=(extra={})=>({baseUrl:'https://api.openai.com/v1',protocol:'openai-responses',model:'fixture-model',enabled:true,maxOutputTokens:2048,...extra});
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'studio-personal-'));
  const config=readConfig({MASTER_KEY:randomBytes(32).toString('hex'),DATA_DIR:dir,BOOTSTRAP_PASSWORD:'fixture-admin-password',PUBLIC_ORIGIN:origin,OPENAI_API_KEY:'fixture-shared-key',ALLOWED_API_HOSTS:'custom.example'});
  const calls=[],modelCalls=[];let fail=false,lister=async()=>({models:[{id:"listed-model",name:"Listed model"}],truncated:false});
  const app=await createApp(config,{modelLister:async(p,options)=>{modelCalls.push(p);return lister(p,options);},providerCaller:async(p)=>{calls.push(p);if(fail)throw new Error('secret failure');return {text:'fixture reply'};}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await app.close();await rm(dir,{recursive:true,force:true});});
  function session(id) {const token=randomToken(),csrf=randomToken();app.db.prepare('INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)').run(tokenHash(token),id,csrf,Date.now()+3600000);return {id,cookie:'studio_session='+token,csrf};}
  const admin=session(app.db.prepare('SELECT id FROM users WHERE role=?').get('admin').id);
  async function request(path,{method='GET',body,auth=admin,csrf=auth?.csrf,requestOrigin=origin}={}) {
    const res=await fetch(`http://127.0.0.1:${app.server.address().port}`+path,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':csrf||''}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,json:await res.json()};
  }
  async function member(name,allowSharedKeys=false) {
    const created=await request('/api/admin/users',{method:'POST',body:{username:name,password:'fixture-member-password',allowSharedKeys}});
    assert.equal(created.status,201);return session(created.json.user.id);
  }
  const a=await member('member-a'),b=await member('member-b');
  await request('/api/admin/providers/openai',{method:'PUT',body:settings()});
  async function chat(auth=a) {const created=await request('/api/conversations',{method:'POST',auth,body:{provider:'openai'}});return request('/api/chat',{method:'POST',auth,body:{conversationId:created.json.conversation.id,message:'hello'}});}
  return {app,config,calls,modelCalls,admin,a,b,request,chat,setLister(fn){lister=fn;},setFailure(){fail=true;}};
}
test('personal provider settings require auth, Origin and CSRF, and cannot grant shared-key permission',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/account/providers',{auth:null})).status,401);
  assert.equal((await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,csrf:'wrong',body:settings({apiKey:'fixture-a'})})).status,403);
  assert.equal((await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,requestOrigin:'https://evil.example',body:settings({apiKey:'fixture-a'})})).status,403);
  const list=await f.request('/api/account/providers',{auth:f.a});assert.equal(list.status,200);assert.equal(list.json.allowSharedKeys,false);
  assert.equal((await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:{source:'shared',allowSharedKeys:true}})).status,403);
  assert.equal((await f.chat()).status,409);assert.equal(f.calls.length,0);
});
test('each member uses only their encrypted personal key and independent model settings',async t=>{
  const f=await fixture(t);
  for(const [auth,key,model] of [[f.a,'fixture-key-a','model-a'],[f.b,'fixture-key-b','model-b']]) {
    const saved=await f.request('/api/account/providers/openai',{method:'PUT',auth,body:settings({apiKey:key,model,userId:f.b.id})});
    assert.equal(saved.status,200);assert.equal(saved.json.provider.hasKey,true);assert.ok(!JSON.stringify(saved.json).includes(key));
    assert.equal((await f.chat(auth)).status,200);
  }
  assert.deepEqual(f.calls.map(p=>[p.apiKey,p.model]),[['fixture-key-a','model-a'],['fixture-key-b','model-b']]);
  const a=f.app.db.prepare('SELECT * FROM personal_providers WHERE user_id=? AND provider_id=?').get(f.a.id,'openai');
  assert.ok(!a.secret.includes('fixture-key-a'));
  assert.equal(decryptSecret(a.secret,f.config.masterKey,`user-provider:${f.a.id}:openai`),'fixture-key-a');
  assert.throws(()=>decryptSecret(a.secret,f.config.masterKey,`user-provider:${f.b.id}:openai`));
  const admin=await f.request('/api/admin/providers');assert.ok(!JSON.stringify(admin).includes('fixture-key-a'));
  const b=await f.request('/api/account/providers',{auth:f.b});assert.equal(b.json.providers[0].model,'model-b');
});
test('personal calls never fall back to shared keys on upstream failure, disabling or deletion',async t=>{
  const f=await fixture(t);
  await f.request(`/api/admin/users/${f.a.id}`,{method:'PATCH',body:{allowSharedKeys:true}});
  await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:settings({apiKey:'fixture-personal-key'})});
  f.setFailure();assert.equal((await f.chat()).status,502);assert.equal(f.calls.length,1);assert.equal(f.calls[0].apiKey,'fixture-personal-key');
  await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:settings({enabled:false})});
  assert.equal((await f.chat()).status,409);
  const deleted=await f.request('/api/account/providers/openai',{method:'DELETE',auth:f.a});assert.equal(deleted.status,200);assert.equal(deleted.json.provider.hasKey,false);assert.equal(deleted.json.provider.source,'personal');
  assert.equal((await f.chat()).status,409);assert.equal(f.calls.length,1);
  assert.equal(f.app.db.prepare('SELECT secret FROM personal_providers WHERE user_id=?').get(f.a.id).secret,'');
});
test('shared-key use requires admin permission and switching from a personal connection is explicit',async t=>{
  const f=await fixture(t);
  const granted=await f.request(`/api/admin/users/${f.a.id}`,{method:'PATCH',body:{allowSharedKeys:true}});assert.equal(granted.json.user.allowSharedKeys,true);
  const switchTo=await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:{source:'shared'}});assert.equal(switchTo.status,200);
  assert.equal((await f.chat()).status,200);assert.equal(f.calls[0].apiKey,'fixture-shared-key');
  await f.request(`/api/admin/users/${f.a.id}`,{method:'PATCH',body:{allowSharedKeys:false}});
  assert.equal((await f.chat()).status,409);assert.equal(f.calls.length,1);
  assert.equal((await f.request('/api/account/providers/openai',{method:'PUT',auth:f.b,body:{source:'shared'}})).status,403);
});
test('changing a personal API destination requires entering its key again and rejects unsafe URLs',async t=>{
  const f=await fixture(t);
  await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:settings({apiKey:'fixture-private-key'})});
  for(const baseUrl of ['http://127.0.0.1','https://169.254.169.254','https://unknown.example/v1'])assert.equal((await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:settings({baseUrl,apiKey:'fixture-new-key'})})).status,400);
  assert.equal((await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:settings({baseUrl:'https://custom.example/v1'})})).status,400);
  assert.equal((await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:settings({baseUrl:'https://custom.example/v1',apiKey:'fixture-custom-key'})})).status,200);
  assert.equal((await f.chat()).status,200);assert.equal(f.calls[0].apiKey,'fixture-custom-key');assert.equal(f.calls[0].baseUrl,'https://custom.example/v1');
});

const discovery=(extra={})=>({baseUrl:'https://api.openai.com/v1',protocol:'openai-responses',...extra});
test('model discovery requires authentication, CSRF and admin scope and never saves input keys',async t=>{
 const f=await fixture(t),path='/api/account/providers/openai/models',body=discovery({apiKey:'fixture-probe-key'});
 assert.equal((await f.request(path,{method:'POST',auth:null,body})).status,401);
 assert.equal((await f.request(path,{method:'POST',auth:f.a,csrf:'wrong',body})).status,403);
 assert.equal((await f.request('/api/admin/providers/openai/models',{method:'POST',auth:f.a,body})).status,403);
 const result=await f.request(path,{method:'POST',auth:f.a,body});assert.equal(result.status,200);assert.equal(result.json.models[0].id,'listed-model');assert.ok(!JSON.stringify(result).includes('fixture-probe-key'));
 assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM personal_providers WHERE user_id=?').get(f.a.id).n,0);assert.equal(f.calls.length,0);
});
test('discovery reuses only the current account key at the unchanged address and never borrows platform keys',async t=>{
 const f=await fixture(t),path='/api/account/providers/openai/models';
 await f.request('/api/account/providers/openai',{method:'PUT',auth:f.a,body:settings({apiKey:'fixture-a'})});
 assert.equal((await f.request(path,{method:'POST',auth:f.b,body:discovery({userId:f.a.id})})).status,400);
 assert.equal((await f.request(path,{method:'POST',auth:f.a,body:discovery({baseUrl:'https://custom.example/v1'})})).status,400);
 assert.equal((await f.request(path,{method:'POST',auth:f.a,body:discovery()})).status,200);assert.equal(f.modelCalls[0].apiKey,'fixture-a');
 assert.equal((await f.request(path,{method:'POST',auth:f.a,body:discovery({baseUrl:'https://custom.example/v1',apiKey:'fixture-new'})})).status,200);assert.equal(f.modelCalls[1].apiKey,'fixture-new');
 assert.equal((await f.request('/api/account/providers',{auth:f.a})).json.providers[0].baseUrl,'https://api.openai.com/v1');
});
test('admin discovery can use an injected key only at its saved API address',async t=>{
 const f=await fixture(t),path='/api/admin/providers/openai/models';
 assert.equal((await f.request(path,{method:'POST',body:discovery()})).status,200);assert.equal(f.modelCalls[0].apiKey,'fixture-shared-key');
 assert.equal((await f.request(path,{method:'POST',body:discovery({baseUrl:'https://custom.example/v1'})})).status,400);
 assert.equal((await f.request(path,{method:'POST',body:discovery({apiKey:'override'})})).status,409);
});
test('discovery throttles repeated calls without consuming paid chat quota',async t=>{
 const f=await fixture(t),path='/api/account/providers/openai/models',body=discovery({apiKey:'fixture-a'});
 for(let i=0;i<10;i++)assert.equal((await f.request(path,{method:'POST',auth:f.a,body})).status,200);
 assert.equal((await f.request(path,{method:'POST',auth:f.a,body})).status,429);
 assert.equal((await f.request('/api/session',{auth:f.a})).json.usage.used,0);
});
test('one discovery per account runs at a time and unexpected errors never leak keys',async t=>{
 const f=await fixture(t);let finish,started;const ready=new Promise(r=>started=r);
 f.setLister(()=>new Promise(r=>{finish=r;started();}));
 const path='/api/account/providers/openai/models',body=discovery({apiKey:'fixture-a'});
 const first=f.request(path,{method:'POST',auth:f.a,body});await ready;
 assert.equal((await f.request(path,{method:'POST',auth:f.a,body})).status,409);
 finish({models:[],truncated:false});assert.equal((await first).status,200);
 f.setLister(()=>{throw new Error('fixture-a private upstream failure');});const failure=await f.request(path,{method:'POST',auth:f.a,body});assert.equal(failure.status,502);assert.ok(!JSON.stringify(failure).includes('fixture-a'));
});
