import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import WebSocket from 'ws';
import {cloudflare} from './lib/worker-api.mjs';
const route='/workers/scripts/crawling-air-tickets/tails',session=await cloudflare(route,{method:'POST',body:{}});
const ws=new WebSocket(session.url,'trace-v1'),events=[];
ws.addEventListener('message',message=>{
  try{const e=JSON.parse(String(message.data));events.push({outcome:e.outcome,event_type:e.event?.queue?'queue':e.event?.cron?'cron':'fetch',
    cpu_ms:e.cpuTime,wall_ms:e.wallTime,exceptions:e.exceptions?.map(x=>({name:x.name,message:x.message})),
    logs:e.logs?.flatMap(l=>l.message||[]).flatMap(m=>{try{return [JSON.parse(m)];}catch{return [];}})});}catch{}
});
try{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Tail open timeout')),15000);
    ws.once('open',()=>ws.send(JSON.stringify({debug:false}),{mask:false,compress:false,binary:false},error=>{clearTimeout(timer);error?reject(error):resolve();}));
    ws.once('error',()=>{clearTimeout(timer);reject(new Error('Tail failed'));});
  });
  if(process.argv.includes('--preflight')){
    const result=await promisify(execFile)(process.execPath,['--dns-result-order=ipv4first','scripts/cloudflare-runtime.mjs','--preflight'],{windowsHide:true});
    process.stdout.write(result.stdout);
  }
  await new Promise(r=>setTimeout(r,process.argv.includes('--preflight')?10000:45000));
}finally{
  ws.terminate();await cloudflare(route+'/'+session.id,{method:'DELETE'}).catch(()=>{});
  const filename='data/worker-tail-'+Date.now()+'.json';await writeFile(filename,JSON.stringify(events,null,2)+'\n');
  console.log(JSON.stringify({file:filename,events:events.map(e=>({outcome:e.outcome,event_type:e.event_type,cpu_ms:e.cpu_ms,wall_ms:e.wall_ms,
    resources:e.logs?.filter(l=>l.event==='job_resources'),exceptions:e.exceptions}))},null,2));
}
