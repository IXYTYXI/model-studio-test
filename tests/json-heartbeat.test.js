import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {startJsonHeartbeat,hasJsonHeartbeat} from '../src/json-heartbeat.js';
import {json} from '../src/http.js';
function response(){const r=new EventEmitter();r.headersSent=false;r.writableEnded=false;r.destroyed=false;r.chunks=[];r.headers={};r.writeHead=(status,headers)=>{assert.equal(r.headersSent,false);r.status=status;Object.assign(r.headers,headers);r.headersSent=true;};r.write=chunk=>{r.chunks.push(chunk);return true;};r.end=chunk=>{if(chunk)r.chunks.push(chunk);r.writableEnded=true;r.emit('finish');};return r;}
test('JSON heartbeat keeps idle responses active and preserves final JSON',t=>{
 t.mock.timers.enable({apis:['setInterval']});const res=response();const stop=startJsonHeartbeat(res);
 t.mock.timers.tick(14999);assert.equal(res.headersSent,false);t.mock.timers.tick(1);assert.equal(hasJsonHeartbeat(res),true);assert.equal(res.headers['X-Accel-Buffering'],'no');
 t.mock.timers.tick(60000);assert.equal(res.chunks.length,5);stop();json(res,200,{ok:true});assert.deepEqual(JSON.parse(res.chunks.join('')),{ok:true});
 const n=res.chunks.length;t.mock.timers.tick(60000);assert.equal(res.chunks.length,n);
});
test('heartbeat errors carry logical status and closed clients stop writes',t=>{
 t.mock.timers.enable({apis:['setInterval']});const res=response();startJsonHeartbeat(res);t.mock.timers.tick(15000);json(res,504,{error:{code:'PROVIDER_TIMEOUT',message:'超时'}});
 assert.equal(res.status,200);assert.equal(JSON.parse(res.chunks.join('')).error.status,504);
 const closed=response();startJsonHeartbeat(closed);closed.destroyed=true;closed.emit('close');t.mock.timers.tick(60000);assert.equal(closed.chunks.length,0);
});
test('fast errors retain HTTP error status without heartbeat envelope',()=>{
 const res=response();const stop=startJsonHeartbeat(res);stop();json(res,400,{error:{code:'INVALID_INPUT'}});assert.equal(res.status,400);assert.equal(JSON.parse(res.chunks.join('')).error.status,undefined);
});
