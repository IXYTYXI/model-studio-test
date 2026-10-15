import {randomUUID} from 'node:crypto';
import {randomToken,tokenHash,equalToken,RateLimiter} from './security.js';
import {AppError} from './errors.js';
import {json,readJson,cookieToken} from './http.js';
import {createGoogleClient} from './google-auth.js';

const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const lifetime=10*60*1000;

// OAuth state is short-lived and bound to a separate Lax cookie. The normal
// application session remains SameSite=Strict. Restarting invalidates pending flows.
export function createGoogleLogin({config,db,issueSession,client,now=Date.now}) {
  const enabled=!!config.google,secure=config.publicOrigin.startsWith('https:');
  const flowCookieName=`${secure?'__Host-':''}studio_google_flow`;
  const google=enabled?(client||createGoogleClient(config.google)):null;
  const pending=new Map(),rate=new RateLimiter({limit:15,windowMs:lifetime,now});
  let inFlight=0;
  function sweep(){for(const [key,flow] of pending)if(flow.expires<=now())pending.delete(key);}
  function flowCookie(res,value,maxAge) {
    const valueString=`${flowCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
    const existing=res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie',existing?[...(Array.isArray(existing)?existing:[existing]),valueString]:valueString);
  }
  function redirect(res,error) {
    flowCookie(res,'',0);
    res.writeHead(303,{Location:error?`/login?google_error=${error}`:'/codex'});res.end();
  }
  function account(identity) {
    if(!identity||typeof identity.sub!=='string'||!identity.sub||identity.sub.length>255||typeof identity.email!=='string'||identity.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email))throw new Error('Invalid Google identity');
    db.exec('BEGIN IMMEDIATE');
    try {
      let user=db.prepare('SELECT users.* FROM google_accounts JOIN users ON users.id=google_accounts.user_id WHERE google_accounts.subject=?').get(identity.sub);
      if(user&&!user.enabled){db.exec('ROLLBACK');return {error:'disabled'};}
      if(!user) {
        if(db.prepare('SELECT count(*) AS n FROM users').get().n>=100){db.exec('ROLLBACK');return {error:'capacity'};}
        const id=randomUUID(),username='google-'+randomToken().slice(0,20).toLowerCase(),createdAt=new Date(now()).toISOString();
        // Never match by email or assign an admin role. This password marker is
        // deliberately not a valid scrypt record; a local password is not created.
        db.prepare('INSERT INTO users(id,username,password,role,daily_limit,created_at,allow_shared_keys) VALUES(?,?,?,?,?,?,0)').run(id,username,'!google-only','member',config.defaultDailyLimit,createdAt);
        db.prepare('INSERT INTO google_accounts(subject,user_id,email,created_at) VALUES(?,?,?,?)').run(identity.sub,id,identity.email,createdAt);
        user=db.prepare('SELECT * FROM users WHERE id=?').get(id);
      } else db.prepare('UPDATE google_accounts SET email=? WHERE subject=?').run(identity.email,identity.sub);
      db.exec('COMMIT');return {user};
    } catch(error){db.exec('ROLLBACK');throw error;}
  }
  return async function handle(req,res,url) {
    const path=url.pathname;
    if(req.method==='GET'&&path==='/api/auth/config'){json(res,200,{google:{enabled}});return true;}
    if(req.method==='POST'&&path==='/api/auth/google/start') {
      if(!enabled)throw new AppError(404,'GOOGLE_NOT_CONFIGURED','Google 登录尚未配置');
      await readJson(req);sweep();
      if(!rate.take(req.socket.remoteAddress||'unknown')||pending.size>=1000)throw new AppError(429,'LOGIN_LIMIT','登录尝试过多，请稍后再试');
      const state=randomToken(),binding=randomToken(),nonce=randomToken(),codeVerifier=randomToken();
      pending.set(tokenHash(state),{bindingHash:tokenHash(binding),nonce,codeVerifier,expires:now()+lifetime});
      flowCookie(res,binding,lifetime/1000);
      json(res,200,{url:google.authorizationUrl({state,nonce,codeVerifier})});return true;
    }
    if(req.method!=='GET'||path!=='/api/auth/google/callback')return false;
    if(!enabled){redirect(res,'unavailable');return true;}
    sweep();
    const state=url.searchParams.get('state'),binding=cookieToken(req,flowCookieName);
    const flow=state&&tokenPattern.test(state)&&pending.get(tokenHash(state));
    if(url.searchParams.getAll('state').length!==1||!flow||!binding||!equalToken(flow.bindingHash,tokenHash(binding))){redirect(res,'failed');return true;}
    pending.delete(tokenHash(state)); // Consume before any awaited exchange, including failures.
    if(url.searchParams.has('error')){redirect(res,'cancelled');return true;}
    const code=url.searchParams.get('code');
    if(url.searchParams.getAll('code').length!==1||!code||code.length>4096||/[\x00-\x20\x7f]/.test(code)){redirect(res,'failed');return true;}
    if(inFlight>=4){redirect(res,'unavailable');return true;}
    inFlight++;
    try {
      const identity=await google.exchange({code,nonce:flow.nonce,codeVerifier:flow.codeVerifier});
      const result=account(identity);
      if(result.error)redirect(res,result.error);
      else {issueSession(result.user,res);redirect(res);}
    } catch {redirect(res,'failed');}
    finally {inFlight--;}
    return true;
  };
}
