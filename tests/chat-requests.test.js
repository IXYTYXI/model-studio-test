import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatRequests} from '../public/chat-requests.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('a reply remains bound to its origin while the visible workspace changes',async()=>{
 const reply=deferred(),events=[],calls=[];let visible='openai';
 const requests=createChatRequests({api:async(path,options)=>{calls.push({path,options});return reply.promise;},onChange:(task,phase)=>events.push({id:task.id,phase,visible})});
 const task=requests.start({provider:'openai',conversationId:'one',message:'original',messages:[]});
 visible='gemini';assert.equal(requests.pendingFor('openai','one'),task);assert.equal(task.provider,'openai');
 reply.resolve({conversation:{id:'one',provider:'openai',title:'original'},messages:[{role:'assistant',content:'answer'}],usage:{used:1}});await task.done;
 assert.equal(visible,'gemini');assert.equal(requests.pending.length,0);assert.equal(task.status,'complete');assert.equal(task.messages[0].content,'answer');assert.equal(calls[0].options.body.conversationId,'one');assert.equal(events.at(-1).visible,'gemini');
});

test('navigation during conversation creation still sends the original provider and message',async()=>{
 const creation=deferred(),calls=[],events=[];
 const requests=createChatRequests({api:async(path,options)=>{calls.push({path,options});if(path==='/api/conversations')return creation.promise;return {conversation:{id:'new-id'},messages:[],usage:{used:1}};},onChange:(_task,phase)=>events.push(phase)});
 const task=requests.start({provider:'anthropic',message:'hello',messages:[],originGeneration:8});
 assert.throws(()=>requests.start({provider:'anthropic',message:'duplicate',originGeneration:8}),/正在生成/);
 creation.resolve({conversation:{id:'new-id',provider:'anthropic',title:'新对话'}});await task.done;
 assert.equal(calls[0].options.body.provider,'anthropic');assert.equal(calls[1].options.body.conversationId,'new-id');assert.equal(task.originGeneration,8);assert.deepEqual(events,['started','created','settled']);
});

test('background failure retains original content and committed history for retry',async()=>{
 const original=[{role:'assistant',content:'older'}];
 const requests=createChatRequests({api:async path=>{if(path==='/api/chat')throw new Error('等待模型超时');if(path==='/api/session')return {usage:{used:2}};return {messages:original};}});
 const task=requests.start({provider:'openai',conversationId:'one',message:'failed draft',messages:original});await task.done;
 assert.equal(task.status,'error');assert.equal(task.error,'等待模型超时');assert.equal(task.message,'failed draft');assert.deepEqual(task.messages,original);assert.equal(task.usage.used,2);assert.equal(requests.pending.length,0);
});

test('logout aborts pending work and prevents stale completion reaching a new session',async()=>{
 const reply=deferred(),events=[];
 const requests=createChatRequests({api:()=>reply.promise,onChange:(_task,phase)=>events.push(phase)});
 const task=requests.start({provider:'openai',conversationId:'one',message:'private'});requests.clear();
 assert.equal(task.controller.signal.aborted,true);assert.equal(requests.tasks.length,0);
 reply.resolve({conversation:{id:'one'},messages:[{content:'private answer'}]});await task.done;assert.deepEqual(events,['started']);
});

test('a failed conversation creation releases the pending slot without sending to another thread',async()=>{
 const calls=[];const requests=createChatRequests({api:async path=>{calls.push(path);if(path==='/api/session')return {usage:{used:0}};throw new Error('创建失败');}});
 const task=requests.start({provider:'gemini',message:'hello'});await task.done;
 assert.equal(task.status,'error');assert.equal(task.id,null);assert.equal(requests.pending.length,0);assert.equal(calls.includes('/api/chat'),false);
});

test('logout during creation cannot start a paid request or publish stale conversation state',async()=>{
 const creation=deferred(),paths=[];
 const requests=createChatRequests({api:path=>{paths.push(path);return creation.promise;}});
 const task=requests.start({provider:'openai',message:'private'});requests.clear();creation.resolve({conversation:{id:'stale'}});await task.done;
 assert.deepEqual(paths,['/api/conversations']);assert.equal(requests.tasks.length,0);
});

test('reconciliation keeps the originating conversation and does not clear a newer task',async()=>{
 const lookup=deferred();const paths=[];
 const requests=createChatRequests({api:async path=>{paths.push(path);if(path==='/api/chat')throw new Error('offline');if(path==='/api/conversations/one')return lookup.promise;return {usage:{used:1}};}});
 const old=requests.start({provider:'openai',conversationId:'one',message:'one'});
 await Promise.resolve();requests.clear();
 const next=requests.start({provider:'gemini',conversationId:'two',message:'two'});
 lookup.resolve({messages:[{content:'old reply'}]});await old.done;await next.done;
 assert.ok(requests.tasks.includes(next));assert.equal(next.provider,'gemini');assert.ok(paths.includes('/api/conversations/one'));
});


test('parallel conversations finish independently out of order and keep all unseen notifications',async()=>{
 const replies=new Map(['one','two','three'].map(id=>[id,deferred()]));
 const requests=createChatRequests({api:(_path,options)=>replies.get(options.body.conversationId).promise});
 const one=requests.start({provider:'openai',conversationId:'one',message:'one'});
 const two=requests.start({provider:'gemini',conversationId:'two',message:'two'});
 const three=requests.start({provider:'openai',conversationId:'three',message:'three'});
 assert.equal(requests.pending.length,3);assert.throws(()=>requests.start({provider:'openai',conversationId:'one',message:'duplicate'}),/正在生成/);
 const finish=async(task)=>{replies.get(task.id).resolve({conversation:{id:task.id},messages:[{content:'answer '+task.id}],usage:{used:3}});await task.done;};
 await finish(two);assert.equal(requests.pending.length,2);requests.acknowledge(two);assert.equal(requests.tasks.includes(two),false);assert.equal(one.controller.signal.aborted,false);
 await finish(three);await finish(one);assert.deepEqual(requests.tasks.map(t=>t.id),['one','three']);assert.equal(one.messages[0].content,'answer one');assert.equal(three.messages[0].content,'answer three');
});

test('parallel new chats have separate creation and logout cancels all requests',async()=>{
 const created=deferred(),requests=createChatRequests({api:()=>created.promise});
 const first=requests.start({provider:'openai',message:'one',originGeneration:1});
 const second=requests.start({provider:'openai',message:'two',originGeneration:2});
 const third=requests.start({provider:'gemini',message:'three',originGeneration:3});
 assert.equal(requests.pending.length,3);requests.clear();
 for(const task of [first,second,third])assert.equal(task.controller.signal.aborted,true);
 created.resolve({conversation:{id:'ignored'}});await Promise.all([first.done,second.done,third.done]);assert.equal(requests.tasks.length,0);
});
