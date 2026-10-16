import {validateProviderConfig,requestProviderJson} from './providers.js';
import {AppError} from './errors.js';

const failures = {
  MODEL_LIST_AUTH: [400, 'API Key 无效或无权查询模型，请检查该地址对应的 Key。'],
  MODEL_LIST_UNSUPPORTED: [400, '此地址不支持模型列表查询，请核对 API 基础地址和协议，或手动填写模型 ID。'],
  MODEL_LIST_RATE_LIMIT: [429, '服务商限制了查询频率，请稍后重试。'],
  MODEL_LIST_INVALID: [502, '服务商未返回有效的模型列表，可手动填写模型 ID。'],
  MODEL_LIST_TIMEOUT: [504, '获取模型超时，请重试或手动填写模型 ID。'],
  MODEL_LIST_FAILED: [502, '无法获取模型，请检查地址、协议和网络连接，或手动填写模型 ID。'],
};
const fail = code => new AppError(failures[code][0],code,failures[code][1]);
const validId = value => typeof value==='string' && value.length<=160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/.test(value);
export function normalizeDiscoveryConfig(config,allowedHosts) {
  if(!config || typeof config!=='object')throw new AppError(400,'INVALID_PROVIDER_CONFIG','请填写 API 基础地址和协议');
  return {...validateProviderConfig(config.id,{baseUrl:config.baseUrl,protocol:config.protocol,enabled:false,model:''},allowedHosts),id:config.id};
}

// References: OpenAI /models, Anthropic /models, Gemini models.list.
// Discovery only lists metadata; it never performs a generation or follows an upstream URL.
export async function listModels(config,{allowedHosts,signal}={}) {
  const normalized=normalizeDiscoveryConfig(config,allowedHosts);
  if(typeof config.apiKey!=='string'||!/^[\x21-\x7e]{1,8192}$/.test(config.apiKey))throw new AppError(400,'MODEL_LIST_KEY_REQUIRED','请填写 API Key 后获取模型');
  const headers={Accept:'application/json','Accept-Encoding':'identity'};
  const nativeGemini=normalized.protocol==='gemini',nativeClaude=normalized.protocol==='anthropic';
  if(nativeGemini)headers['x-goog-api-key']=config.apiKey;
  else if(nativeClaude){headers['x-api-key']=config.apiKey;headers['anthropic-version']='2023-06-01';}
  else headers.Authorization=`Bearer ${config.apiKey}`;
  const controller=new AbortController();let timedOut=false;
  const cancel=()=>controller.abort();
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{timedOut=true;cancel();},20000);
  const models=[],seen=new Set(),cursors=new Set();let cursor='',truncated=false;
  try {
    for(let page=0;page<10;page++) {
      const url=new URL(normalized.baseUrl+'/models');
      if(nativeGemini){url.searchParams.set('pageSize','1000');if(cursor)url.searchParams.set('pageToken',cursor);}
      if(nativeClaude){url.searchParams.set('limit','100');if(cursor)url.searchParams.set('after_id',cursor);}
      const response=await requestProviderJson({url:String(url),method:'GET',headers},{signal:controller.signal});
      const rows=nativeGemini?response?.models:response?.data;
      if(!response || response.error || !Array.isArray(rows))throw fail('MODEL_LIST_INVALID');
      for(const row of rows) {
        if(nativeGemini && Array.isArray(row?.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent'))continue;
        const id=nativeGemini?(typeof row?.name==='string'?row.name.replace(/^models\//,''):undefined):row?.id;
        if(!validId(id)||seen.has(id))continue;
        if(models.length>=1000){truncated=true;break;}
        seen.add(id);
        const label=nativeGemini?row.displayName:row.display_name;
        const limit=nativeGemini?row.outputTokenLimit:nativeClaude?row.max_tokens:row.max_output_tokens;
        models.push({id,name:typeof label==='string'?label.slice(0,200):id,...(Number.isSafeInteger(limit)&&limit>0?{maxOutputTokens:limit}:{})});
      }
      const next=nativeGemini?response.nextPageToken:nativeClaude&&response.has_more?response.last_id:'';
      if(!next||truncated)break;
      if(typeof next!=='string'||next.length>2048||cursors.has(next))throw fail('MODEL_LIST_INVALID');
      cursors.add(next);cursor=next;
      if(page===9)truncated=true;
    }
    return {models,truncated,baseUrl:normalized.baseUrl,protocol:normalized.protocol};
  } catch(error) {
    if(timedOut)throw fail('MODEL_LIST_TIMEOUT');
    if(error instanceof AppError)throw error;
    if([401,403].includes(error.upstreamStatus))throw fail('MODEL_LIST_AUTH');
    if([404,405].includes(error.upstreamStatus))throw fail('MODEL_LIST_UNSUPPORTED');
    if(error.upstreamStatus===429)throw fail('MODEL_LIST_RATE_LIMIT');
    if(error.code==='PROVIDER_INVALID_RESPONSE')throw fail('MODEL_LIST_INVALID');
    throw fail('MODEL_LIST_FAILED');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
