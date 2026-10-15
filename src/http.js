import {AppError} from './errors.js';
export function json(res,status,value) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
export async function readJson(req) {
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw new AppError(415,'JSON_REQUIRED','请求必须使用 JSON');
  const limit=96*1024;
  if(Number(req.headers['content-length'])>limit)throw new AppError(413,'BODY_TOO_LARGE','请求内容过大');
  let size=0;const parts=[];
  for await(const part of req) {size+=part.length;if(size>limit)throw new AppError(413,'BODY_TOO_LARGE','请求内容过大');parts.push(part);}
  try {const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
  catch {throw new AppError(400,'INVALID_JSON','请求 JSON 格式不正确');}
}
export function headers(res,secure) {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if(secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
}
export function cookie(res,token,secure,maxAge=43200) {
  res.setHeader('Set-Cookie',`studio_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`);
}
export function sessionToken(req) {
  const match=(req.headers.cookie||'').match(/(?:^|;\s*)studio_session=([a-zA-Z0-9_-]{43})(?:;|$)/);
  return match?match[1]:null;
}
