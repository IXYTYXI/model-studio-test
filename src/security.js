import {scrypt, randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {requireValue} from './errors.js';
const derive=promisify(scrypt);
const COST={N:32768,r:8,p:3,maxmem:64*1024*1024};
export function validatePassword(value) {
  requireValue(typeof value==='string' && value.length>=14 && value.length<=128,'密码长度须为 14–128 个字符');
}
export async function hashPassword(value) {
  validatePassword(value); const salt=randomBytes(16);
  const hash=await derive(value,salt,32,COST);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}
export async function verifyPassword(value,record) {
  if(typeof value!=='string'||value.length>128) return false;
  const pieces=String(record).split(':');
  if(pieces.length!==3||pieces[0]!=='scrypt'||!/^[a-f0-9]{32}$/.test(pieces[1])||!/^[a-f0-9]{64}$/.test(pieces[2])) return false;
  const actual=await derive(value,Buffer.from(pieces[1],'hex'),32,COST);
  return timingSafeEqual(actual,Buffer.from(pieces[2],'hex'));
}
export const randomToken=()=>randomBytes(32).toString('base64url');
export const tokenHash=value=>createHash('sha256').update(value).digest('hex');
export function equalToken(left,right) {
  if(typeof left!=='string'||typeof right!=='string')return false;
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export function encryptSecret(value,key,context) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(context));
  const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),bytes.toString('base64url')].join('.');
}
export function decryptSecret(value,key,context) {
  const [version,iv,tag,data,...rest]=value.split('.');
  if(version!=='v1'||rest.length||!iv||!tag||!data)throw new Error('Invalid encrypted secret');
  const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));
  cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(tag,'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString('utf8');
}
export class RateLimiter {
  constructor({limit,windowMs,maxEntries=10000,now=Date.now}) {Object.assign(this,{limit,windowMs,maxEntries,now});this.entries=new Map();}
  take(key) {
    const time=this.now();
    for(const [id,row] of this.entries)if(row.until<=time)this.entries.delete(id);
    let row=this.entries.get(key);
    if(!row){if(this.entries.size>=this.maxEntries)return false;row={used:0,until:time+this.windowMs};this.entries.set(key,row);}
    if(row.used>=this.limit)return false;row.used++;return true;
  }
}
