import {createApp} from './app.js';
import {readConfig} from './config.js';
process.umask(0o077);
try {
  const config=readConfig(),app=await createApp(config);
  app.server.listen(config.port,config.host,()=>console.log(`Model Studio ready on port ${config.port}`));
  let stopping=false;
  for(const name of ['SIGTERM','SIGINT'])process.on(name,async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);});
} catch(error) {console.error(`Startup failed: ${error.message}`);process.exitCode=1;}
