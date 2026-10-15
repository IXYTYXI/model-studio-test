"""Exercise only task-owned disposable Docker resources; never calls a model API."""
import json
import os
import secrets
import subprocess
import time
import uuid

image = os.environ.get('TEST_IMAGE', 'model-studio:verify-20261014')
identity = 'model-studio-check-' + uuid.uuid4().hex[:12]
volume = identity + '-data'
env = dict(os.environ, MASTER_KEY=secrets.token_hex(32), BOOTSTRAP_USERNAME='verify',
           BOOTSTRAP_PASSWORD=secrets.token_urlsafe(32), PUBLIC_ORIGIN='http://localhost:8080')

def docker(*args, check=True):
    return subprocess.run(['docker', *args], env=env, text=True, capture_output=True, check=check).stdout.strip()

def start():
    docker('run', '-d', '--name', identity, '--network', 'none', '--read-only', '--user', '65532:65532',
           '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
           '--memory', '512m', '--cpus', '1', '--ulimit', 'nofile=1024:1024', '--shm-size', '16m',
           '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777', '--mount', f'type=volume,src={volume},dst=/data',
           '-e', 'MASTER_KEY', '-e', 'BOOTSTRAP_USERNAME', '-e', 'BOOTSTRAP_PASSWORD', '-e', 'PUBLIC_ORIGIN', image)
    for _ in range(30):
        result = subprocess.run(['docker', 'exec', identity, 'node', '-e', "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], capture_output=True)
        if result.returncode == 0:
            return
        time.sleep(0.2)
    raise RuntimeError('Container did not become healthy')

script = r"""
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 assert.equal(process.getuid(),65532);
 assert.throws(()=>fs.writeFileSync('/app/readonly-check','x'),e=>e.code==='EROFS');
 const base='http://127.0.0.1:8080',origin=process.env.PUBLIC_ORIGIN;
 let r=await fetch(base+'/api/session');assert.equal(r.status,401);
 r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
 r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'verify',password:process.env.BOOTSTRAP_PASSWORD})});assert.equal(r.status,200);
 const cookie=r.headers.get('set-cookie').split(';')[0],session=await r.json();
 const headers={Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken};
 let list=await (await fetch(base+'/api/conversations',{headers})).json();
 if(!list.conversations.length){
   r=await fetch(base+'/api/conversations',{method:'POST',headers,body:JSON.stringify({provider:'openai'})});assert.equal(r.status,201);
   r=await fetch(base+'/api/admin/providers/openai',{method:'PUT',headers,body:JSON.stringify({baseUrl:'https://api.openai.com/v1',model:'',enabled:false,protocol:'openai-responses',apiKey:'disposable-fixture-key',maxOutputTokens:2048})});assert.equal(r.status,200);
 }
 list=await (await fetch(base+'/api/conversations',{headers})).json();assert.equal(list.conversations.length,1);
 const providers=await (await fetch(base+'/api/admin/providers',{headers})).json();
 assert.equal(providers.providers.find(p=>p.id==='openai').hasKey,true);assert.ok(!JSON.stringify(providers).includes('disposable-fixture-key'));
 r=await fetch(base+'/codex');assert.equal(r.status,200);assert.ok((await r.text()).includes('Model Studio'));
 console.log(JSON.stringify({uid:process.getuid(),readonly:true,health:true,anonymousDenied:true,foreignOriginDenied:true,secretNotReturned:true,conversationId:list.conversations[0].id,userId:session.user.id}));
})().catch(()=>{console.error('Container acceptance assertion failed');process.exitCode=1;});
"""
try:
    docker('volume', 'create', volume)
    start()
    first=json.loads(docker('exec',identity,'node','-e',script))
    docker('rm','-f',identity)
    start()
    second=json.loads(docker('exec',identity,'node','-e',script))
    assert first['conversationId']==second['conversationId'] and first['userId']==second['userId']
    print(json.dumps({'image':image,'firstRun':first,'afterRecreate':second,'persistence':'passed',
                      'networkDuringTest':'none','realProviderCalls':'not performed','scope':'Docker Desktop Linux arm64, not a production rootless server'},indent=2))
finally:
    docker('rm','-f',identity,check=False)
    docker('volume','rm',volume,check=False)
