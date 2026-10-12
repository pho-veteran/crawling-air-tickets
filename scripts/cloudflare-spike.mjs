// Create a temporary tail, run one probe, save sanitized evidence, remove tail.
import {readFile,writeFile} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import path from 'node:path';
import WebSocket from 'ws';
loadEnvFile('.env.spike');
const base=process.env.SPIKE_URL||'https://crawling-air-tickets-spike.thanhvinhlqt2016.workers.dev';
const storageMode=process.argv.includes('--storage'),queueMode=storageMode||process.argv.includes('--queue');
const prefix=process.env.SPIKE_OUTPUT_PREFIX||(storageMode?'cloudflare-storage':queueMode?'cloudflare-queue':'cloudflare-spike');
if(!/^[a-z0-9-]+$/.test(prefix))throw new Error('Invalid probe evidence prefix.');
const resultFile='data/'+prefix+'-result.json',tailFile='data/'+prefix+'-tail.json';
const completionEvent=storageMode?'storage_check_complete':'probe_complete';
const authPath=process.env.CF_AUTH_FILE||path.join(process.env.APPDATA,'xdg.config/cloudflare/config/default.json');
const token=process.env.CLOUDFLARE_API_TOKEN||JSON.parse(await readFile(authPath,'utf8')).oauth_token;
const api='https://api.cloudflare.com/client/v4/accounts/c0caa75e344cbfbb5ad55cfc712bbc30/workers/scripts/crawling-air-tickets-spike/tails';
const tailResponse=await fetch(api,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
const tailEnvelope=await tailResponse.json();
if(!tailResponse.ok||!tailEnvelope.success)throw new Error('Could not create tail session: HTTP '+tailResponse.status);
const session=tailEnvelope.result;
const ws=new WebSocket(session.url,'trace-v1'),events=[];
let expectedRunId;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
ws.addEventListener('message',async message=>{
  try {
    const text=typeof message.data==='string'?message.data:String(message.data);
    const value=JSON.parse(text);
    // Keep only metrics and our sanitized logs. Tail request headers are excluded.
    const event={outcome:value.outcome,cpuTime:value.cpuTime,wallTime:value.wallTime,
      scriptName:value.scriptName,eventTimestamp:value.eventTimestamp,event_type:value.event?.queue?'queue':'fetch',
      exceptions:value.exceptions?.map(e=>({name:e.name,message:e.message})),
      logs:value.logs?.map(l=>({level:l.level,message:l.message,timestamp:l.timestamp}))};
    events.push(event);
  } catch {console.error('Tail message could not be parsed');}
});
try {
await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Tail WebSocket open timeout')),15000);
  ws.addEventListener('open',()=>{
    // The trace-v1 service waits for the same initialization frame Wrangler sends.
    ws.send(JSON.stringify({debug:false}),{binary:false,compress:false,mask:false},error=>{
      clearTimeout(timer);if(error)reject(error);else resolve();
    });
  },{once:true});
  ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Tail WebSocket failed'));},{once:true});
});
  const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
  console.log('health HTTP',health.status);
  const denied=await fetch(base+'/probe',{method:'POST',signal:AbortSignal.timeout(15000)});
  console.log('unauthorized probe HTTP',denied.status);
  const response=await fetch(base+(storageMode?'/storage-check':queueMode?'/probe-queue':'/probe'),{method:'POST',headers:{authorization:'Bearer '+process.env.PROBE_SECRET},signal:AbortSignal.timeout(140000)});
  const raw=await response.text();let result;
  try {result=JSON.parse(raw);} catch {result={http_status:response.status,non_json:true};}
  expectedRunId=result.run_id;
  await writeFile(resultFile,JSON.stringify({http_status:response.status,result},null,2)+'\n');
  console.log(JSON.stringify({http_status:response.status,run_id:result.run_id,wall_ms:result.wall_ms,requests:result.requests,
    results:result.results?.map(r=>({source:r.source,status:r.snapshot?.status||r.status,main_price:r.snapshot?.main_price,error:r.error,
      leg_errors:r.snapshot?.leg_errors,date_errors:r.snapshot?.date_errors,response_bytes:r.snapshot?.response_bytes}))},null,2));
  // Allow the same live request's tail event to arrive. This never invokes again.
  const until=Date.now()+(queueMode?60000:20000);
  while(Date.now()<until&&!events.some(e=>e.logs?.some(l=>l.message?.some?.(m=>String(m).includes(completionEvent)&&String(m).includes(result.run_id||completionEvent)))))await sleep(500);
} finally {
  ws.terminate();
  await fetch(api+'/'+session.id,{method:'DELETE',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)}).catch(()=>{});
  await writeFile(tailFile,JSON.stringify(events,null,2)+'\n');
  console.log(JSON.stringify(events.map(e=>({outcome:e.outcome,event_type:e.event_type,cpuTime:e.cpuTime,wallTime:e.wallTime,exceptions:e.exceptions,
    completion:e.logs?.flatMap(l=>l.message||[]).filter(m=>String(m).includes(completionEvent))})),null,2));
  const completed=events.find(e=>e.logs?.flatMap(l=>l.message||[]).some(m=>{
    try {const value=JSON.parse(m);return value.event===completionEvent&&value.run_id===expectedRunId;}catch{return false;}
  }));
  if(!completed||completed.outcome!=='ok'){console.error('Missing successful correlated completion evidence; inspect persisted Workers Logs.');process.exitCode=1;}
}
