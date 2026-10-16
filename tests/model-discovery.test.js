import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {listModels,normalizeDiscoveryConfig} from '../src/model-discovery.js';
const cfg=(extra={})=>({id:'openai',baseUrl:'https://gateway.example',protocol:'openai-chat',apiKey:'fixture-private-key',...extra});
const options={allowedHosts:new Set(['*'])};
function upstream(t,replies=[{data:[{id:'vendor/chat-1'},{id:'chat-2'}]}],addresses=[{address:'93.184.216.34',family:4}]) {
 const calls=[];t.mock.method(dns,'lookup',async()=>addresses);
 t.mock.method(https,'request',(url,opts,cb)=>{const req=new EventEmitter();req.destroy=()=>{req.destroyed=true;};req.end=body=>{calls.push({url:String(url),opts,body,req});queueMicrotask(()=>{const reply=replies.shift();if(reply===undefined)return;const res=new PassThrough();res.statusCode=reply.status||200;res.headers={};cb(res);if(!res.destroyed)res.end(typeof reply==='string'?reply:JSON.stringify(reply));});};return req;});return calls;
}
test('gateway root is normalized and GET uses a header key with pinned public TLS destination',async t=>{
 const calls=upstream(t);const result=await listModels(cfg(),options);
 assert.deepEqual(result.models.map(m=>m.id),['vendor/chat-1','chat-2']);assert.equal(result.baseUrl,'https://gateway.example/v1');
 assert.equal(calls[0].url,'https://gateway.example/v1/models');assert.equal(calls[0].opts.method,'GET');assert.equal(calls[0].body,undefined);assert.equal(calls[0].opts.headers.Authorization,'Bearer fixture-private-key');assert.equal(calls[0].opts.rejectUnauthorized,true);
 calls[0].opts.lookup('gateway.example',{},(e,a)=>assert.equal(a,'93.184.216.34'));assert.ok(!JSON.stringify(result).includes('fixture-private-key'));
});
test('all workspaces accept OpenAI-compatible endpoints and normalize version/root paths',()=>{
 for(const id of ['openai','anthropic','gemini'])assert.equal(normalizeDiscoveryConfig(cfg({id}),options.allowedHosts).baseUrl,'https://gateway.example/v1');
 assert.equal(normalizeDiscoveryConfig(cfg({baseUrl:'https://gateway.example/custom/v1/'}),options.allowedHosts).baseUrl,'https://gateway.example/custom/v1');
 assert.equal(normalizeDiscoveryConfig(cfg({id:'gemini',protocol:'gemini'}),options.allowedHosts).baseUrl,'https://gateway.example/v1beta');
});
test('Anthropic paginates using IDs without following a supplied URL',async t=>{
 const calls=upstream(t,[{data:[{id:'claude-a',display_name:'Claude A'}],has_more:true,last_id:'claude-a'},{data:[{id:'claude-b'}],has_more:false}]);
 const result=await listModels(cfg({id:'anthropic',protocol:'anthropic',baseUrl:'https://gateway.example/v1'}),options);
 assert.equal(calls.length,2);assert.equal(calls[0].opts.headers['x-api-key'],'fixture-private-key');assert.ok(calls[1].url.includes('after_id=claude-a'));assert.equal(result.models[0].name,'Claude A');assert.equal(result.models.length,2);
});
test('Gemini paginates, strips resource prefix and only lists generateContent models',async t=>{
 const calls=upstream(t,[{models:[{name:'models/gemini-a',displayName:'Gemini A',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'next+page'},{models:[{name:'models/gemini-b',supportedGenerationMethods:['generateContent']}]}]);
 const result=await listModels(cfg({id:'gemini',protocol:'gemini'}),options);
 assert.deepEqual(result.models.map(m=>m.id),['gemini-a','gemini-b']);assert.ok(calls[1].url.includes('pageToken=next%2Bpage'));assert.equal(calls[0].opts.headers['x-goog-api-key'],'fixture-private-key');
});
test('models are deduplicated and malformed IDs are omitted; unexpected replies fail safely',async t=>{
 upstream(t,[{data:[{id:'valid'},{id:'valid'},{id:'../invalid'},{id:'<script>'},null]}]);assert.deepEqual((await listModels(cfg(),options)).models.map(m=>m.id),['valid']);
 await t.test('invalid JSON shape',async t=>{upstream(t,[{error:'fixture-private-key'}]);await assert.rejects(listModels(cfg(),options),e=>e.code==='MODEL_LIST_INVALID'&&!e.message.includes('fixture-private-key'));});
});
test('auth, unsupported endpoint and throttling errors are actionable and never echo upstream body',async t=>{
 for(const [status,code] of [[401,'MODEL_LIST_AUTH'],[403,'MODEL_LIST_AUTH'],[404,'MODEL_LIST_UNSUPPORTED'],[429,'MODEL_LIST_RATE_LIMIT']])await t.test(String(status),async t=>{upstream(t,[{status,error:'fixture-private-key'}]);await assert.rejects(listModels(cfg(),options),e=>e.code===code&&!e.message.includes('fixture-private-key'));});
});
test('private/mixed DNS, redirects and URL credentials cannot receive keys',async t=>{
 let calls=upstream(t,[],[{address:'127.0.0.1',family:4}]);await assert.rejects(listModels(cfg(),options));assert.equal(calls.length,0);
 await t.test('redirect',async t=>{const calls=upstream(t,[{status:302}]);await assert.rejects(listModels(cfg(),options));assert.equal(calls.length,1);});
 for(const baseUrl of ['http://gateway.example','https://user:pass@gateway.example','https://127.0.0.1','https://gateway.example:8443','https://gateway.example?key=x'])assert.throws(()=>normalizeDiscoveryConfig(cfg({baseUrl}),options.allowedHosts));
});
test('discovery has one total 20 second deadline, including DNS',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(dns,'lookup',()=>new Promise(()=>{}));const pending=listModels(cfg(),options);t.mock.timers.tick(20000);await assert.rejects(pending,e=>e.code==='MODEL_LIST_TIMEOUT');
});
test('cancelled discovery stops in-flight transport',async t=>{
 const calls=upstream(t,[]);const c=new AbortController();const pending=listModels(cfg(),{...options,signal:c.signal});await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(pending);assert.equal(calls[0].req.destroyed,true);
});
test('pagination is bounded and reports truncation',async t=>{
 const calls=upstream(t,Array.from({length:20},(_,i)=>({data:[{id:'model-'+i}],has_more:true,last_id:'model-'+i})));
 const result=await listModels(cfg({id:'anthropic',protocol:'anthropic'}),options);assert.ok(calls.length<=10);assert.equal(result.truncated,true);
});

test('custom API hosts are explicitly enabled and keep strict URL validation',async()=>{
 const {readConfig}=await import('../src/config.js');
 const env={MASTER_KEY:'a'.repeat(64),BOOTSTRAP_PASSWORD:'fixture-admin-password'};
 assert.equal(readConfig(env).allowedHosts.has('*'),false);
 const hosts=readConfig({...env,ALLOW_CUSTOM_API_HOSTS:'true'}).allowedHosts;
 assert.equal(normalizeDiscoveryConfig(cfg(),hosts).baseUrl,'https://gateway.example/v1');
 assert.throws(()=>readConfig({...env,ALLOW_CUSTOM_API_HOSTS:'yes'}));
 assert.throws(()=>normalizeDiscoveryConfig(cfg({baseUrl:'https://10.0.0.1'}),hosts));
});
test('malformed Gemini records are ignored and results are capped at 1000',async t=>{
 upstream(t,[{models:[{name:123},{name:'models/valid'}]}]);assert.equal((await listModels(cfg({id:'gemini',protocol:'gemini'}),options)).models.length,1);
 await t.test('bounded list',async t=>{upstream(t,[{data:Array.from({length:1002},(_,i)=>({id:'model-'+i}))}]);const result=await listModels(cfg(),options);assert.equal(result.models.length,1000);assert.equal(result.truncated,true);});
});

test('only explicit output limits are normalized, never context-window sizes',async t=>{
 const cases=[
  ['openai','openai-chat',{data:[{id:'known',max_output_tokens:131072},{id:'context-only',context_length:1000000},{id:'invalid',max_output_tokens:-1}]}],
  ['anthropic','anthropic',{data:[{id:'known',max_tokens:64000},{id:'context-only',max_input_tokens:1000000}]}],
  ['gemini','gemini',{models:[{name:'models/known',outputTokenLimit:65536},{name:'models/context-only',inputTokenLimit:1000000}]}]
 ];
 for(const [id,protocol,reply] of cases)await t.test(protocol,async t=>{
  upstream(t,[reply]);const {models}=await listModels(cfg({id,protocol}),options);
  assert.ok(models[0].maxOutputTokens>4096);assert.equal(models[1].maxOutputTokens,undefined);
  if(models[2])assert.equal(models[2].maxOutputTokens,undefined);
 });
});

test('model discovery retains its 2 MiB transport limit independently of generation',async t=>{
 upstream(t,[{data:[{id:'model',display_name:'x'.repeat(2*1024*1024)}]}]);
 await assert.rejects(listModels(cfg(),options),e=>e.code==='MODEL_LIST_INVALID');
});
