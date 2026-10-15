import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {encryptSecret,decryptSecret,hashPassword} from './security.js';

export async function openStore(config,defaults) {
  mkdirSync(config.dataDir,{recursive:true,mode:0o700});
  const file=join(config.dataDir,'studio.sqlite3');
  const db=new DatabaseSync(file,{timeout:5000});chmodSync(file,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,daily_limit INTEGER NOT NULL DEFAULT 50,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS google_accounts (subject TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,email TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY,label TEXT NOT NULL,base_url TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',protocol TEXT NOT NULL,secret TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 0,max_output INTEGER NOT NULL DEFAULT 2048);
    CREATE TABLE IF NOT EXISTS personal_providers (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider_id TEXT NOT NULL REFERENCES providers(id),base_url TEXT NOT NULL,model TEXT NOT NULL,protocol TEXT NOT NULL,secret TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 0,max_output INTEGER NOT NULL DEFAULT 2048,source TEXT NOT NULL DEFAULT 'personal',PRIMARY KEY(user_id,provider_id));
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),provider TEXT NOT NULL REFERENCES providers(id),title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (user_id TEXT NOT NULL REFERENCES users(id),day TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,day));
    CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(user_id,updated_at);
    CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,id);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);`);
  try {
    // Preserve existing members' shared access on upgrade. All newly provisioned
    // members explicitly choose their permission in the registration routes.
    if(!db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='allow_shared_keys'))db.exec('ALTER TABLE users ADD COLUMN allow_shared_keys INTEGER NOT NULL DEFAULT 1');
    const check=db.prepare('SELECT value FROM settings WHERE name=?').get('key_check');
    if(check) {if(decryptSecret(check.value,config.masterKey,'key_check')!=='model-studio')throw new Error('Master key mismatch');}
    else db.prepare('INSERT INTO settings(name,value) VALUES(?,?)').run('key_check',encryptSecret('model-studio',config.masterKey,'key_check'));
    for(const p of defaults)db.prepare('INSERT OR IGNORE INTO providers(id,label,base_url,protocol) VALUES(?,?,?,?)').run(p.id,p.label,p.baseUrl,p.protocol);
    if(!db.prepare('SELECT id FROM users LIMIT 1').get()) {
      if(!config.bootstrapPassword)throw new Error('First start requires BOOTSTRAP_PASSWORD (14–128 characters)');
      const password=await hashPassword(config.bootstrapPassword);
      db.prepare('INSERT INTO users(id,username,password,role,daily_limit,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(),config.bootstrapUsername,password,'admin',config.defaultDailyLimit,new Date().toISOString());
    }
    return db;
  } catch(error){db.close();throw error;}
}
