import {listModels,normalizeDiscoveryConfig} from './model-discovery.js';
import {decryptSecret,RateLimiter} from './security.js';
import {AppError,requireValue} from './errors.js';

export function createModelDiscovery({db,config,lister=listModels}) {
  const rate=new RateLimiter({limit:10,windowMs:60000});
  const globalRate=new RateLimiter({limit:60,windowMs:60000,maxEntries:1});
  const busy=new Set();
  return async function discover({scope,id,body,user,signal}) {
    const admin=scope==='admin';
    if(admin&&user.role!=='admin')throw new AppError(403,'ADMIN_REQUIRED','仅管理员可以进行此操作');
    const connection=normalizeDiscoveryConfig({...body,id},config.allowedHosts);
    requireValue(body.apiKey===undefined||typeof body.apiKey==='string','API Key 格式不正确');
    const managed=admin&&config.providerKeys?.[id];
    if(managed&&body.apiKey)throw new AppError(409,'PROVIDER_KEY_MANAGED','此 Key 由平台管理，请通过平台秘密配置更新');
    const saved=admin?db.prepare('SELECT * FROM providers WHERE id=?').get(id)
      :db.prepare('SELECT * FROM personal_providers WHERE user_id=? AND provider_id=?').get(user.id,id);
    let apiKey=body.apiKey;
    if(!apiKey&&(managed||saved?.secret)) {
      const previous=normalizeDiscoveryConfig({id,baseUrl:saved.base_url,protocol:saved.protocol},config.allowedHosts);
      requireValue(previous.baseUrl===connection.baseUrl,'API 地址已更改，请重新填写对应 Key；平台管理的 Key 须先确认并保存新地址。');
      apiKey=managed||decryptSecret(saved.secret,config.masterKey,admin?id:`user-provider:${user.id}:${id}`);
    }
    requireValue(typeof apiKey==='string'&&/^[\x21-\x7e]{1,8192}$/.test(apiKey),'请填写 API Key 后获取模型；个人连接不会借用平台 Key。');
    if(busy.has(user.id))throw new AppError(409,'MODEL_LIST_BUSY','正在获取模型，请等待当前查询完成');
    if(busy.size>=4||!rate.take(user.id)||!globalRate.take('all'))throw new AppError(429,'MODEL_LIST_LIMIT','模型查询过于频繁，请稍后重试');
    busy.add(user.id);
    try {return await lister({...connection,apiKey},{allowedHosts:config.allowedHosts,signal});}
    catch(error){if(error instanceof AppError)throw error;throw new AppError(502,'MODEL_LIST_FAILED','无法获取模型，请核对地址、协议和 Key，或手动填写模型 ID。');}
    finally {busy.delete(user.id);}
  };
}
