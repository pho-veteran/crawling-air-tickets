import {readFile,writeFile,mkdir} from 'node:fs/promises';
const read=async name=>JSON.parse(await readFile('data/'+name,'utf8'));
const http=await read('cloudflare-spike-result.json'),httpTail=await read('cloudflare-spike-tail.json');
const queue=await read('cloudflare-queue-result.json'),queueTail=await read('cloudflare-queue-tail.json');
const local=await read('cloudflare-local-vna-comparison.json');
let storage;
try {
  const response=await read('cloudflare-storage-result.json'),tail=await read('cloudflare-storage-tail.json');
  const event=tail.find(e=>e.logs?.flatMap(l=>l.message||[]).some(m=>String(m).includes('storage_check_complete')&&String(m).includes(response.result.run_id)));
  if(!event)throw new Error('Missing correlated D1 completion');
  const completion=event.logs.flatMap(l=>l.message||[]).map(m=>{try{return JSON.parse(m);}catch{return null;}}).find(m=>m?.event==='storage_check_complete');
  storage={run_id:response.result.run_id,http_status:response.http_status,
    consumer_metrics:{outcome:event.outcome,cpu_ms:event.cpuTime,wall_ms:event.wallTime},result:completion};
} catch(error) {if(error.code!=='ENOENT')throw error;}
let localImport;
try {const value=await read('cloudflare-import-validation.json');localImport={observed_at:value.observed_at,backend:value.backend,
  verified:value.verified,summary:value.summary,repeatedInserted:value.repeatedInserted,rawStatePreserved:value.rawStatePreserved,
  liveOutboxTranslation:value.liveOutboxTranslation,remoteImport:value.remoteImport};}catch(error){if(error.code!=='ENOENT')throw error;}
const completion=event=>event.logs?.flatMap(l=>l.message||[]).map(m=>{
  try {return JSON.parse(m);} catch {return null;}
}).find(m=>m?.event==='probe_complete');
const match=(events,id)=>events.find(e=>completion(e)?.run_id===id);
const metrics=event=>({outcome:event?.outcome,cpu_ms:event?.cpuTime,wall_ms:event?.wallTime});
const httpEvent=match(httpTail,http.result.run_id),queueEvent=match(queueTail,queue.result.run_id);
if(!httpEvent||!queueEvent)throw new Error('Missing correlated live invocation evidence');
const record={
  generated_at:new Date().toISOString(),worker_url:'https://crawling-air-tickets-spike.thanhvinhlqt2016.workers.dev',
  http_probe:{run_id:http.result.run_id,observed_at:http.result.observed_at,http_status:http.http_status,
    metrics:metrics(httpEvent),subrequests:http.result.requests,
    results:http.result.results.map(r=>({source:r.source,status:r.snapshot?.status||r.status,error:r.error||null,
      main_price:r.snapshot?.main_price??null,priced_cells:r.snapshot?.cells.filter(c=>c.price!==null).length??0,
      response_bytes:r.snapshot?.response_bytes??null})),
    endpoints:http.result.diagnostics.filter(d=>d.event==='response_headers').map(d=>({source:d.source,request_id:d.request_id,http_status:d.http_status,duration_ms:d.duration_ms}))},
  queue_probe:{run_id:queue.result.run_id,http_status:queue.http_status,consumer_metrics:metrics(queueEvent),
    producer_metrics:queueTail.filter(e=>e.event_type==='fetch').map(metrics),result:completion(queueEvent)},
  local_vna_comparison:local,
  ...(storage?{d1_storage_probe:storage}:{}),
  ...(localImport?{local_import_check:localImport}:{}),
  gates:{vna_from_workers:'failed_http_403',flynow_from_workers:'passed_single_sample',
    free_http_full_crawl:'failed_cpu_budget',free_queue_flynow:'passed_single_sample',
    d1_storage_fixture:storage?'passed_single_sample':'not_measured',local_import:localImport?.verified?'passed_offline_capture':'not_verified',
    sustained_load_d1_memory:'not_measured',staging_24_hours:'not_started',production_cutover:'not_started'},
};
await mkdir('docs/cloudflare-spike',{recursive:true});
const serialized=JSON.stringify(record,null,2)+'\n';
const secretFile=await readFile('.env.spike','utf8'),secret=secretFile.match(/^PROBE_SECRET=(.+)$/m)?.[1].trim();
if(!secret||serialized.includes(secret))throw new Error('Evidence secret guard failed');
await writeFile('docs/cloudflare-spike/evidence.json',serialized);
console.log('Wrote sanitized, correlated evidence to docs/cloudflare-spike/evidence.json');
