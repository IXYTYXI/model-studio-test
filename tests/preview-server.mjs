// Local-only QA fixture. Not copied to the runtime image; no model keys or paid calls.
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createApp} from '../src/app.js';
const port=3939;
const app=await createApp({dataDir:await mkdtemp(join(tmpdir(),'model-studio-preview-')),masterKey:randomBytes(32),bootstrapUsername:'preview',bootstrapPassword:'local-preview-password-2026',publicOrigin:`http://localhost:${port}`,defaultDailyLimit:50,globalDailyLimit:500,allowedHosts:new Set(['api.openai.com','api.anthropic.com','generativelanguage.googleapis.com'])});
app.server.listen(port,'127.0.0.1',()=>console.log(`Preview ready: http://localhost:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
