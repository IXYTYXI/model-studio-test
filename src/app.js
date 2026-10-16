import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from './store.js';
import {AppError,requireValue} from './errors.js';
import {hashPassword,verifyPassword,randomToken,tokenHash,equalToken,encryptSecret,decryptSecret,RateLimiter} from './security.js';
import {json,readJson,headers,cookie,sessionToken} from './http.js';
import {PROVIDER_DEFAULTS,validateProviderConfig,callProvider} from './providers.js';
import {startJsonHeartbeat,hasJsonHeartbeat} from './json-heartbeat.js';
import {createModelDiscovery} from './model-discovery-service.js';
import {createGoogleLogin} from './google-login.js';
import {createPersonalProviders,canUseSharedKeys} from './personal-providers.js';

const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const iso=()=>new Date().toISOString();
const conversationView=c=>({id:c.id,provider:c.provider,title:c.title,createdAt:c.created_at,updatedAt:c.updated_at});
const messageView=m=>({id:m.id,role:m.role,content:m.content,createdAt:m.created_at});
const username=value=>{requireValue(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{1,63}$/.test(value),'用户名须为 2–64 位字母、数字或 . _ @ -');return value.toLowerCase();};
const dailyLimit=value=>{requireValue(Number.isInteger(value)&&value>=1&&value<=10000,'每日调用上限须为 1–10000 的整数');return value;};

export async function createApp(config,{providerCaller=callProvider,modelLister,googleClient,googleNow,chatHeartbeatMs=15000}={}) {
  const db=await openStore(config,PROVIDER_DEFAULTS),secure=config.publicOrigin.startsWith('https:');
  const userView=u=>({id:u.id,username:u.username,role:u.role,enabled:!!u.enabled,dailyLimit:u.role==='admin'?null:u.daily_limit,allowSharedKeys:canUseSharedKeys(u),email:db.prepare('SELECT email FROM google_accounts WHERE user_id=?').get(u.id)?.email||null,passwordEnabled:u.password.startsWith('scrypt:')});
  const environmentKey=id=>config.providerKeys?.[id]||'';
  const keySource=p=>environmentKey(p.id)?'environment':p.secret?'stored':'none';
  const providerView=p=>({id:p.id,label:p.label,baseUrl:p.base_url,model:p.model,protocol:p.protocol,enabled:!!p.enabled,hasKey:keySource(p)!=='none',keySource:keySource(p),maxOutputTokens:p.max_output});
  const personal=createPersonalProviders({db,config,sharedView:providerView});
  const discoverModels=createModelDiscovery({db,config,lister:modelLister});
  const loginByIp=new RateLimiter({limit:15,windowMs:600000});
  const loginByUser=new RateLimiter({limit:8,windowMs:600000});
  const chatRate=new RateLimiter({limit:8,windowMs:60000});
  const busyConversations=new Set(),controllers=new Set();let passwordWork=0;
  const fakeHash=await hashPassword(randomToken());
  const usage=u=>({used:db.prepare('SELECT used FROM usage WHERE user_id=? AND day=?').get(u.id,day())?.used||0,limit:u.role==='admin'?null:u.daily_limit,unlimited:u.role==='admin',day:day()});
  const summaries=u=>PROVIDER_DEFAULTS.map(p=>{const active=personal.effective(u,p.id);return {id:p.id,label:p.label,model:active.model,enabled:active.enabled,configured:active.configured,credentialSource:active.credentialSource};});
  const sessionView=(u,csrf)=>({user:userView(u),csrfToken:csrf,providers:summaries(u),usage:usage(u),version:'1.0.0'});
  function authenticated(req) {
    const token=sessionToken(req,secure);
    const row=token&&db.prepare('SELECT users.*,sessions.csrf,sessions.token FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>? AND users.enabled=1').get(tokenHash(token),Date.now());
    if(!row)throw new AppError(401,'LOGIN_REQUIRED','请先登录');return row;
  }
  function owned(id,u) {
    const c=db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id,u.id);
    if(!c)throw new AppError(404,'NOT_FOUND','会话不存在');return c;
  }
  function thread(c) {return {conversation:conversationView(c),messages:db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(c.id).map(messageView)};}
  async function passwordTask(fn) {
    if(passwordWork>=4)throw new AppError(429,'BUSY','登录请求较多，请稍后再试');
    passwordWork++;try{return await fn();}finally{passwordWork--;}
  }
  function transaction(fn) {db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}
  function issueSession(user,res) {
    const token=randomToken(),csrf=randomToken(),expires=Date.now()+43200000;
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token NOT IN (SELECT token FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT 4)').run(user.id,user.id);
    db.prepare('INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)').run(tokenHash(token),user.id,csrf,expires);
    cookie(res,token,secure);return sessionView(user,csrf);
  }
  const googleLogin=createGoogleLogin({config,db,issueSession,client:googleClient,now:googleNow});

  async function route(req,res) {
    headers(res,secure);
    const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
    const mutation=!['GET','HEAD','OPTIONS'].includes(method);
    if(mutation&&req.headers.origin!==config.publicOrigin)throw new AppError(403,'ORIGIN_DENIED','请求来源不允许');
    if(method==='GET'&&path==='/healthz'){db.prepare('SELECT count(*) FROM settings').get();return json(res,200,{status:'ok'});}
    if(await googleLogin(req,res,url))return;
    if(path==='/api/login'&&method==='POST') {
      const body=await readJson(req),name=typeof body.username==='string'?body.username.toLowerCase():'';
      const ip=req.socket.remoteAddress||'unknown'; // Forwarded headers are untrusted.
      if(!loginByIp.take(ip)||!loginByUser.take(name.slice(0,64)))throw new AppError(429,'LOGIN_LIMIT','登录尝试过多，请 10 分钟后再试');
      const u=db.prepare('SELECT * FROM users WHERE username=?').get(name);
      const valid=await passwordTask(()=>verifyPassword(body.password,u?.password||fakeHash));
      const latest=u&&db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
      if(!valid||!latest?.enabled||latest.password!==u.password)throw new AppError(401,'INVALID_CREDENTIALS','用户名或密码不正确');
      return json(res,200,issueSession(latest,res));
    }
    if(path.startsWith('/api/')) {
      let u;
      function refreshAuth() {
        u=authenticated(req);
        if(mutation&&!equalToken(req.headers['x-csrf-token'],u.csrf))throw new AppError(403,'CSRF_DENIED','请求验证失败，请刷新页面');
        if(path.startsWith('/api/admin/')&&u.role!=='admin')throw new AppError(403,'ADMIN_REQUIRED','仅管理员可以进行此操作');
      }
      refreshAuth();
      async function bodyAfterAuth() {const body=await readJson(req);refreshAuth();return body;}
      const modelsMatch=path.match(/^\/api\/(account|admin)\/providers\/(openai|anthropic|gemini)\/models$/);
      if(modelsMatch&&method==='POST') {
        const body=await bodyAfterAuth(),controller=new AbortController();controllers.add(controller);
        const cancel=()=>{if(!res.writableEnded)controller.abort();};res.on('close',cancel);
        try {
          const result=await discoverModels({scope:modelsMatch[1],id:modelsMatch[2],body,user:u,signal:controller.signal});
          refreshAuth();return json(res,200,result);
        } finally {res.off('close',cancel);controllers.delete(controller);}
      }
      if(path==='/api/session'&&method==='GET')return json(res,200,sessionView(u,u.csrf));
      if(path==='/api/providers'&&method==='GET')return json(res,200,{providers:summaries(u)});
      if(path==='/api/account/providers'&&method==='GET')return json(res,200,personal.settings(u));
      const personalMatch=path.match(/^\/api\/account\/providers\/(openai|anthropic|gemini)$/);
      if(personalMatch&&method==='PUT'){const body=await bodyAfterAuth();return json(res,200,{provider:personal.save(u,personalMatch[1],body)});}
      if(personalMatch&&method==='DELETE')return json(res,200,{provider:personal.clear(u,personalMatch[1])});
      if(path==='/api/logout'&&method==='POST'){db.prepare('DELETE FROM sessions WHERE token=?').run(u.token);cookie(res,'',secure,0);return json(res,200,{ok:true});}
      if(path==='/api/password'&&method==='POST') {
        const b=await bodyAfterAuth(),oldHash=u.password;
        const hashed=await passwordTask(async()=>{if(!await verifyPassword(b.currentPassword,oldHash))throw new AppError(400,'PASSWORD_MISMATCH','当前密码不正确');return hashPassword(b.newPassword);});
        refreshAuth();
        if(u.password!==oldHash)throw new AppError(401,'LOGIN_REQUIRED','密码已更新，请重新登录');
        transaction(()=>{db.prepare('UPDATE users SET password=? WHERE id=?').run(hashed,u.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);});
        cookie(res,'',secure,0);return json(res,200,{ok:true});
      }
      if(path==='/api/admin/providers'&&method==='GET')return json(res,200,{providers:db.prepare('SELECT * FROM providers ORDER BY rowid').all().map(providerView)});
      const providerMatch=path.match(/^\/api\/admin\/providers\/(openai|anthropic|gemini)$/);
      if(providerMatch&&method==='PUT') {
        const b=await bodyAfterAuth(),id=providerMatch[1],p=validateProviderConfig(id,b,config.allowedHosts);
        const old=db.prepare('SELECT * FROM providers WHERE id=?').get(id);
        requireValue(b.apiKey===undefined||typeof b.apiKey==='string','API Key 格式不正确');
        if(environmentKey(id)&&b.apiKey)throw new AppError(409,'PROVIDER_KEY_MANAGED','此 API Key 由平台环境配置管理，请在平台修改；地址、模型和启用状态仍可保存。');
        requireValue(!b.apiKey||(b.apiKey.length<=8192&&!/[\r\n\x00-\x20\x7f]/.test(b.apiKey)),'API Key 不能包含空白且长度须小于 8192');
        const sealed=b.apiKey?encryptSecret(b.apiKey,config.masterKey,id):old.secret;
        requireValue(!p.enabled||!!(environmentKey(id)||sealed),'启用模型前请先配置 API Key');
        db.prepare('UPDATE providers SET base_url=?,model=?,protocol=?,secret=?,enabled=?,max_output=? WHERE id=?')
          .run(p.baseUrl,p.model,p.protocol,sealed,p.enabled?1:0,p.maxOutputTokens,id);
        return json(res,200,{provider:providerView(db.prepare('SELECT * FROM providers WHERE id=?').get(id))});
      }
      if(path==='/api/admin/users'&&method==='GET')return json(res,200,{users:db.prepare('SELECT * FROM users ORDER BY created_at').all().map(row=>({...userView(row),used:usage(row).used}))});
      if(path==='/api/admin/users'&&method==='POST') {
        const b=await bodyAfterAuth(),name=username(b.username),limit=dailyLimit(b.dailyLimit??config.defaultDailyLimit);
        requireValue(b.allowSharedKeys===undefined||typeof b.allowSharedKeys==='boolean','平台连接权限必须是布尔值');
        requireValue(db.prepare('SELECT count(*) AS n FROM users').get().n<100,'最多支持 100 个账号');
        if(db.prepare('SELECT id FROM users WHERE username=?').get(name))throw new AppError(409,'USERNAME_EXISTS','用户名已存在');
        const hashed=await passwordTask(()=>hashPassword(b.password));
        refreshAuth();
        requireValue(db.prepare('SELECT count(*) AS n FROM users').get().n<100,'最多支持 100 个账号');
        if(db.prepare('SELECT id FROM users WHERE username=?').get(name))throw new AppError(409,'USERNAME_EXISTS','用户名已存在');
        const id=randomUUID();db.prepare('INSERT INTO users(id,username,password,role,daily_limit,created_at,allow_shared_keys) VALUES(?,?,?,?,?,?,?)').run(id,name,hashed,'member',limit,iso(),b.allowSharedKeys===true?1:0);
        return json(res,201,{user:userView(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
      }
      const userMatch=path.match(/^\/api\/admin\/users\/([a-f0-9-]{36})$/);
      if(userMatch&&method==='PATCH') {
        const b=await bodyAfterAuth();let target=db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]);
        if(!target)throw new AppError(404,'NOT_FOUND','账号不存在');
        requireValue(b.enabled===undefined||typeof b.enabled==='boolean','账号状态必须是布尔值');
        requireValue(b.allowSharedKeys===undefined||typeof b.allowSharedKeys==='boolean','平台连接权限必须是布尔值');
        requireValue(target.id!==u.id||b.enabled!==false,'不能停用当前管理员');
        const hashed=b.password?await passwordTask(()=>hashPassword(b.password)):target.password;
        refreshAuth();
        target=db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]);
        const limit=target.role==='admin'||b.dailyLimit===undefined?target.daily_limit:dailyLimit(b.dailyLimit);
        transaction(()=>{db.prepare('UPDATE users SET enabled=?,daily_limit=?,password=?,allow_shared_keys=? WHERE id=?').run(b.enabled===undefined?target.enabled:(b.enabled?1:0),limit,hashed,b.allowSharedKeys===undefined?target.allow_shared_keys:(b.allowSharedKeys?1:0),target.id);
          if(b.enabled===false||b.password)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);});
        return json(res,200,{user:userView(db.prepare('SELECT * FROM users WHERE id=?').get(target.id))});
      }
      if(path==='/api/conversations'&&method==='GET') {
        const provider=url.searchParams.get('provider');
        const rows=provider?db.prepare('SELECT * FROM conversations WHERE user_id=? AND provider=? ORDER BY updated_at DESC').all(u.id,provider):db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(u.id);
        return json(res,200,{conversations:rows.map(conversationView)});
      }
      if(path==='/api/conversations'&&method==='POST') {
        const b=await bodyAfterAuth();requireValue(PROVIDER_DEFAULTS.some(p=>p.id===b.provider),'请选择有效的模型服务');
        requireValue(db.prepare('SELECT count(*) AS n FROM conversations WHERE user_id=?').get(u.id).n<500,'会话数量已达上限，请删除不需要的会话');
        const id=randomUUID(),now=iso();db.prepare('INSERT INTO conversations(id,user_id,provider,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,u.id,b.provider,'新对话',now,now);
        return json(res,201,{conversation:conversationView(owned(id,u))});
      }
      const cMatch=path.match(/^\/api\/conversations\/([a-f0-9-]{36})$/);
      if(cMatch&&['GET','DELETE'].includes(method)) {
        const c=owned(cMatch[1],u);
        if(method==='GET')return json(res,200,thread(c));
        if(busyConversations.has(c.id))throw new AppError(409,'CHAT_BUSY','请等此对话回复完成再删除');
        db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(c.id,u.id);return json(res,200,{ok:true});
      }
      if(path==='/api/chat'&&method==='POST') {
        const b=await bodyAfterAuth();requireValue(typeof b.conversationId==='string','请选择会话');
        const c=owned(b.conversationId,u);
        requireValue(typeof b.message==='string'&&b.message.trim().length>0&&b.message.length<=16000,'消息须为 1–16000 个字符');
        if(busyConversations.has(c.id))throw new AppError(429,'CHAT_BUSY','此对话正在生成回复，请等待完成后继续提问');
        if(busyConversations.size>=4)throw new AppError(429,'SERVER_BUSY','服务当前正在处理较多回复，请稍后重试');
        const p=personal.effective(u,c.provider);
        if(!p.configured)throw new AppError(409,'PROVIDER_NOT_CONFIGURED','请在个人模型设置中配置 API Key 和模型，或联系管理员授权平台连接');
        requireValue(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(c.id).n<1000,'会话过长，请新建对话');
        if(u.role!=='admin'&&!chatRate.take(u.id))throw new AppError(429,'CHAT_RATE_LIMIT','发送过于频繁，请稍后再试');
        transaction(()=>{
          if(u.role!=='admin') {
            const current=usage(u),global=db.prepare("SELECT coalesce(sum(usage.used),0) AS n FROM usage JOIN users ON users.id=usage.user_id WHERE usage.day=? AND users.role!='admin'").get(day()).n;
            if(current.used>=u.daily_limit||global>=config.globalDailyLimit)throw new AppError(429,'DAILY_LIMIT','今日调用额度已用完');
          }
          db.prepare('INSERT INTO usage(user_id,day,used) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET used=used+1').run(u.id,day());
        });
        busyConversations.add(c.id);const controller=new AbortController();controllers.add(controller);
        const stopHeartbeat=startJsonHeartbeat(res,{intervalMs:chatHeartbeatMs});
        const cancel=()=>{if(!res.writableEnded)controller.abort();};res.on('close',cancel);
        try {
          const history=db.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 40').all(c.id).reverse();
          let size=b.message.length;
          const context=[];
          for(let i=history.length-1;i>=0;i--){if(size+history[i].content.length>64000)break;context.unshift(history[i]);size+=history[i].content.length;}
          while(context.length&&context[0].role!=='user')context.shift();
          context.push({role:'user',content:b.message.trim()});
          let answer;
          try {answer=await providerCaller(personal.effective(u,c.provider,true),context,{allowedHosts:config.allowedHosts,signal:controller.signal,timeoutMs:config.providerTimeoutMs??300000});}
          catch(error) {
            if(error?.code==='PROVIDER_TIMEOUT')throw new AppError(504,'PROVIDER_TIMEOUT','等待模型回复超时，请降低输出长度或联系管理员调整等待时间。');
            if(error?.code==='PROVIDER_REJECTED')throw new AppError(400,'PROVIDER_REJECTED','服务商拒绝了请求参数，请检查模型支持的最大输出 Token、模型名称和接口协议。');
            throw new AppError(502,'PROVIDER_FAILED','模型调用失败，请检查 API 地址、密钥、模型名称、额度和网络连接后重试');
          }
          if(controller.signal.aborted)return;
          refreshAuth();
          if(!answer||typeof answer.text!=='string'||!answer.text.trim()||answer.text.length>1000000)throw new AppError(502,'INVALID_PROVIDER_RESPONSE','模型没有返回有效文本');
          const now=iso();
          transaction(()=>{const insert=db.prepare('INSERT INTO messages(conversation_id,role,content,created_at) VALUES(?,?,?,?)');insert.run(c.id,'user',b.message.trim(),now);insert.run(c.id,'assistant',answer.text,now);
            db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').run(c.title==='新对话'?b.message.trim().slice(0,48):c.title,now,c.id);});
          return json(res,200,{...thread(owned(c.id,u)),usage:usage(u)});
        } finally {stopHeartbeat();res.off('close',cancel);busyConversations.delete(c.id);controllers.delete(controller);}
      }
      throw new AppError(404,'NOT_FOUND','接口不存在');
    }
    if(!['GET','HEAD'].includes(method))throw new AppError(405,'METHOD_NOT_ALLOWED','请求方法不支持');
    let relative=['/','/login','/codex','/claude','/gemini','/settings'].includes(path)?'index.html':decodeURIComponent(path).replace(/^\//,'');
    const target=resolve(publicDir,relative),extension=extname(target);
    if(!target.startsWith(resolve(publicDir)+sep)||!['.html','.css','.js','.svg','.ico'].includes(extension))throw new AppError(404,'NOT_FOUND','页面不存在');
    let bytes;try{bytes=await readFile(target);}catch{throw new AppError(404,'NOT_FOUND','页面不存在');}
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'})[extension]});
    res.end(method==='HEAD'?undefined:bytes);
  }
  const server=createServer((req,res)=>{route(req,res).catch(error=>{
    if(res.destroyed||res.writableEnded)return;
    const known=error instanceof AppError;
    const providerValidation=!known&&Number.isInteger(error.status)&&error.status===400&&typeof error.code==='string'&&error.code.startsWith('INVALID_');
    if(res.headersSent&&!hasJsonHeartbeat(res)){res.destroy();return;}
    json(res,known?error.status:providerValidation?400:500,{error:{code:known?error.code:providerValidation?'INVALID_PROVIDER_CONFIG':'INTERNAL_ERROR',message:known?error.message:providerValidation?'模型配置无效，请检查 API 地址、模型及协议':'服务暂时不可用，请稍后重试'}});
  });});
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=64;
  return {server,db,async close(){for(const c of controllers)c.abort();await new Promise(resolve=>server.close(resolve));server.closeAllConnections();db.close();}};
}
