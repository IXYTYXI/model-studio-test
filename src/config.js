import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
function secret(env,name) {return env[`${name}_FILE`]?readFileSync(env[`${name}_FILE`],'utf8').trim():env[name];}
function integer(value,fallback,min,max) {const n=Number(value??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error('Invalid numeric server setting');return n;}
export function readConfig(env=process.env) {
  const raw=secret(env,'MASTER_KEY');
  if(!raw||!/^[a-fA-F0-9]{64}$/.test(raw))throw new Error('MASTER_KEY must be 64 hexadecimal characters; run npm run setup');
  const publicOrigin=new URL(env.PUBLIC_ORIGIN||'http://localhost:8080');
  if(publicOrigin.username||publicOrigin.password||publicOrigin.pathname!=='/'||publicOrigin.search||publicOrigin.hash)throw new Error('PUBLIC_ORIGIN must contain only the public origin');
  if(publicOrigin.protocol!=='https:'&&!(publicOrigin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(publicOrigin.hostname)))throw new Error('PUBLIC_ORIGIN requires HTTPS except on loopback');
  const allowedHosts=new Set(['api.openai.com','api.anthropic.com','generativelanguage.googleapis.com']);
  for(const host of (env.ALLOWED_API_HOSTS||'').split(',').filter(Boolean)) {
    const name=host.trim().toLowerCase();
    if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(name))throw new Error('ALLOWED_API_HOSTS requires exact DNS hostnames');
    allowedHosts.add(name);
  }
  if(env.ALLOW_CUSTOM_API_HOSTS!==undefined&&!['true','false'].includes(env.ALLOW_CUSTOM_API_HOSTS))throw new Error('ALLOW_CUSTOM_API_HOSTS must be true or false');
  if(env.ALLOW_CUSTOM_API_HOSTS==='true')allowedHosts.add('*');
  const bootstrapUsername=(env.BOOTSTRAP_USERNAME||'admin').toLowerCase();
  if(!/^[a-z0-9][a-z0-9_.@-]{1,63}$/.test(bootstrapUsername))throw new Error('Invalid BOOTSTRAP_USERNAME');
  const providerKeys={};
  for(const [id,name] of [['openai','OPENAI_API_KEY'],['anthropic','ANTHROPIC_API_KEY'],['gemini','GEMINI_API_KEY']]) {
    const value=env[name];
    if(value===undefined||value==='')continue;
    if(typeof value!=='string'||!/^[\x21-\x7e]{1,8192}$/.test(value))throw new Error('Invalid provider API key setting');
    providerKeys[id]=value;
  }
  const googleId=env.GOOGLE_CLIENT_ID,googleSecret=secret(env,'GOOGLE_CLIENT_SECRET');
  let google=null;
  if(googleId||googleSecret) {
    if(typeof googleId!=='string'||!/^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(googleId)||typeof googleSecret!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(googleSecret))throw new Error('Google login requires a valid client ID and client secret');
    google={clientId:googleId,clientSecret:googleSecret,redirectUri:publicOrigin.origin+'/api/auth/google/callback'};
  }
  return {masterKey:Buffer.from(raw,'hex'),publicOrigin:publicOrigin.origin,allowedHosts,providerKeys,google,
    dataDir:resolve(env.DATA_DIR||'data'),bootstrapUsername,bootstrapPassword:secret(env,'BOOTSTRAP_PASSWORD'),
    port:integer(env.PORT,8080,1,65535),host:env.HOST||'0.0.0.0',
    defaultDailyLimit:integer(env.DEFAULT_DAILY_LIMIT,50,1,10000),globalDailyLimit:integer(env.GLOBAL_DAILY_LIMIT,500,1,100000)};
}
