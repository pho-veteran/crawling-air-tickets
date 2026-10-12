// Manual source revalidation only; never sends Telegram or changes production data.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import path from 'node:path';
loadEnvFile('.env.spike');
const base=process.env.SPIKE_URL||'https://crawling-air-tickets-spike.thanhvinhlqt2016.workers.dev';
const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-');
const output='data/selected-sources-'+stamp+'.json';
const routes=['/probe',...(process.argv.includes('--official')?['/vna-diagnostic']:[])];
const checks=await Promise.all(routes.map(async route=>{
  const response=await fetch(base+route,{method:'POST',headers:{authorization:'Bearer '+process.env.PROBE_SECRET},signal:AbortSignal.timeout(45000)});
  const result=await response.json();return {route,http_status:response.status,result};
}));
await mkdir('data',{recursive:true});
const record={observed_at:new Date().toISOString(),checks};
await writeFile(output,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({output,checks:checks.map(c=>({route:c.route,http_status:c.http_status,run_id:c.result.run_id,requests:c.result.requests,
  sources:c.result.results?.map(r=>({source:r.source,status:r.snapshot?.status||r.status,http_status:r.http_status,
    main_price:r.snapshot?.main_price,error:r.error}))}))},null,2));
if(checks.some(c=>c.http_status!==200)||checks[0].result.results?.some(r=>r.snapshot?.status!=='ok'))process.exitCode=1;
// Attach persisted metrics for exactly the same run, without invoking sources again.
try{
  const token=process.env.CLOUDFLARE_API_TOKEN||JSON.parse(await readFile(path.join(process.env.APPDATA,'xdg.config/cloudflare/config/default.json'),'utf8')).oauth_token;
  await new Promise(r=>setTimeout(r,10000));
  const response=await fetch('https://api.cloudflare.com/client/v4/accounts/c0caa75e344cbfbb5ad55cfc712bbc30/workers/observability/telemetry/query',{
    method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},signal:AbortSignal.timeout(15000),
    body:JSON.stringify({queryId:'selected-source-check',view:'events',limit:100,timeframe:{from:Date.parse(checks[0].result.observed_at)-30000,to:Date.now()},
      parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'crawling-air-tickets-spike'}]}})});
  const data=await response.json();if(!response.ok||!data.success)throw new Error('Telemetry not available');
  const events=data.result.events.events;
  record.metrics=checks.map(c=>{
    const completion=events.find(e=>e.source?.run_id===c.result.run_id&&['probe_complete','vna_diagnostic_complete'].includes(e.source?.event));
    const id=completion?.$workers?.requestId||completion?.$metadata?.requestId;
    const invocation=id?events.find(e=>(e.$workers?.requestId||e.$metadata?.requestId)===id&&e.$workers?.cpuTimeMs!==undefined):null;
    return {run_id:c.result.run_id,request_id:id,outcome:invocation?.$workers.outcome,cpu_ms:invocation?.$workers.cpuTimeMs,wall_ms:invocation?.$workers.wallTimeMs};
  });
  await writeFile(output,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({metrics:record.metrics},null,2));
  if(record.metrics.some(m=>m.outcome!=='ok'))process.exitCode=1;
}catch{console.error('Source evidence saved; metrics unavailable. Refresh cf auth and inspect persisted Workers Logs.');process.exitCode=1;}
