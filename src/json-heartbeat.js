// JSON permits leading whitespace. Keep the proxy connection active while the
// provider is generating, without exposing partial output or changing fast calls.
const started=new WeakSet();
export const hasJsonHeartbeat=res=>started.has(res);
export function startJsonHeartbeat(res,{intervalMs=15000}={}) {
  const stop=()=>{clearInterval(timer);res.off('close',stop);res.off('finish',stop);};
  const timer=setInterval(()=>{
    if(res.destroyed||res.writableEnded){stop();return;}
    if(!res.headersSent){
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','X-Accel-Buffering':'no'});
      started.add(res);
    }
    if(started.has(res))res.write(' \n');
  },intervalMs);
  timer.unref?.();res.once('close',stop);res.once('finish',stop);return stop;
}
