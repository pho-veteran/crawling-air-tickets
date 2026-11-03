import {readFile,writeFile} from 'node:fs/promises';
import {cloudflare,RemoteD1,worker} from './lib/worker-api.mjs';
const database=JSON.parse(await readFile('data/worker-database.json','utf8')),db=new RemoteD1(database.id);
const logs=await cloudflare('/workers/observability/telemetry/query',{method:'POST',body:{queryId:'production-capacity',view:'events',limit:1000,
  timeframe:{from:Date.now()-3600000,to:Date.now()},parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'crawling-air-tickets'}]}}});
const events=logs.events.events,invocations=events.filter(e=>e.$workers?.cpuTimeMs!==undefined),metrics=[];
for(const type of ['fetch','scheduled','queue']){
  const samples=invocations.filter(e=>e.$workers.eventType===type).map(e=>e.$workers);
  if(samples.length)metrics.push({type,samples:samples.length,max_cpu_ms:Math.max(...samples.map(s=>s.cpuTimeMs)),
    max_wall_ms:Math.max(...samples.map(s=>s.wallTimeMs)),outcomes:[...new Set(samples.map(s=>s.outcome))]});
}
const resources=[];
for(const e of events){let l=e.source;
  if(typeof l?.message==='string')try{l=JSON.parse(l.message);}catch{}
  if(l?.event==='job_resources')resources.push({kind:l.kind,...l.d1});
}
const d1=[];for(const kind of [...new Set(resources.map(r=>r.kind))]){
  const rows=resources.filter(r=>r.kind===kind);d1.push({kind,samples:rows.length,
    max_statements:Math.max(...rows.map(r=>r.statements)),max_rows_read:Math.max(...rows.map(r=>r.rows_read)),max_rows_written:Math.max(...rows.map(r=>r.rows_written))});
}
const counts={};for(const table of ['observations','price_quotes','price_minima'])counts[table]=(await db.prepare('SELECT COUNT(*) AS n FROM '+table).first()).n;
const info=await cloudflare('/d1/database/'+database.id),c=await worker('/admin/context');
const result={captured_at:new Date().toISOString(),health:await worker('/health'),state:await worker('/admin/state'),pricing_counts:counts,
  database_size_bytes:info.file_size??null,prices:c.providers.map(p=>({id:p.id,status:p.history.at(-1)?.status,current:p.history.at(-1)?.main_price,minimums:p.minimums})),
  metrics,d1,measured_heap_bytes:null,notes:['Short production smoke samples; separate staging bot and 24 hours waived by user.','Metrics include production versions in the last hour; not a sustained-load benchmark.']};
await writeFile('docs/cloudflare-spike/production-evidence.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
