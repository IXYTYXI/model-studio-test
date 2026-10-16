import {AppError,requireValue} from './errors.js';
import {encryptSecret,decryptSecret} from './security.js';
import {PROVIDER_DEFAULTS,validateProviderConfig} from './providers.js';

export const canUseSharedKeys=user=>user.role==='admin'||user.allow_shared_keys===1;
const context=(user,id)=>`user-provider:${user.id}:${id}`;

export function createPersonalProviders({db,config,sharedView}) {
  const row=(user,id)=>db.prepare('SELECT * FROM personal_providers WHERE user_id=? AND provider_id=?').get(user.id,id);
  function initial(user,id) {
    const defaults=PROVIDER_DEFAULTS.find(p=>p.id===id);
    return {provider_id:id,base_url:defaults.baseUrl,model:'',protocol:defaults.protocol,enabled:0,secret:'',max_output:8192,source:canUseSharedKeys(user)?'shared':'personal'};
  }
  function view(user,id) {
    const own=row(user,id)||initial(user,id);
    return {id,label:PROVIDER_DEFAULTS.find(p=>p.id===id).label,baseUrl:own.base_url,model:own.model,protocol:own.protocol,enabled:!!own.enabled,hasKey:!!own.secret,maxOutputTokens:own.max_output,source:own.source,keySource:own.secret?'personal':'none'};
  }
  function effective(user,id,withKey=false) {
    const own=row(user,id);
    if(own?.source==='personal') {
      const result={...view(user,id),configured:!!(own.enabled&&own.secret&&own.model),credentialSource:'personal'};
      if(withKey&&result.configured)result.apiKey=decryptSecret(own.secret,config.masterKey,context(user,id));
      return result;
    }
    if(!canUseSharedKeys(user))return {...view(user,id),enabled:false,configured:false,credentialSource:'none'};
    const shared=db.prepare('SELECT * FROM providers WHERE id=?').get(id),result={...sharedView(shared),credentialSource:'shared'};
    result.configured=!!(result.enabled&&result.hasKey&&result.model);
    if(withKey&&result.configured)result.apiKey=config.providerKeys?.[id]||decryptSecret(shared.secret,config.masterKey,id);
    return result;
  }
  const saveRow=(user,id,p)=>db.prepare(`INSERT INTO personal_providers(user_id,provider_id,base_url,model,protocol,secret,enabled,max_output,source) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,provider_id) DO UPDATE SET base_url=excluded.base_url,model=excluded.model,protocol=excluded.protocol,secret=excluded.secret,enabled=excluded.enabled,max_output=excluded.max_output,source=excluded.source`)
    .run(user.id,id,p.base_url,p.model,p.protocol,p.secret,p.enabled,p.max_output,p.source);
  function save(user,id,body) {
    requireValue(body.source===undefined||['personal','shared'].includes(body.source),'请选择个人连接或平台连接');
    const old=row(user,id)||initial(user,id);
    if(body.source==='shared') {
      if(!canUseSharedKeys(user))throw new AppError(403,'SHARED_KEY_DENIED','管理员尚未授权此账号使用平台连接，请配置个人 API Key');
      saveRow(user,id,{...old,source:'shared'});return view(user,id);
    }
    const p=validateProviderConfig(id,body,config.allowedHosts);
    requireValue(body.apiKey===undefined||typeof body.apiKey==='string','API Key 格式不正确');
    requireValue(!body.apiKey||(body.apiKey.length<=8192&&/^[\x21-\x7e]+$/.test(body.apiKey)),'API Key 须为不含空白的可打印字符，最多 8192 位');
    requireValue(!old.secret||old.base_url===p.baseUrl||!!body.apiKey,'更改 API 地址时，请重新填写该地址对应的 API Key');
    const secret=body.apiKey?encryptSecret(body.apiKey,config.masterKey,context(user,id)):old.secret;
    requireValue(!p.enabled||!!secret,'启用个人连接前请先填写 API Key');
    saveRow(user,id,{base_url:p.baseUrl,model:p.model,protocol:p.protocol,secret,enabled:p.enabled?1:0,max_output:p.maxOutputTokens,source:'personal'});
    return view(user,id);
  }
  function clear(user,id) {
    // Keep the explicit personal selection so removing a key cannot start
    // charging a shared platform key on the next request.
    saveRow(user,id,{...(row(user,id)||initial(user,id)),secret:'',enabled:0,source:'personal'});
    return view(user,id);
  }
  return {effective,save,clear,settings:user=>({allowSharedKeys:canUseSharedKeys(user),providers:PROVIDER_DEFAULTS.map(p=>view(user,p.id))})};
}
