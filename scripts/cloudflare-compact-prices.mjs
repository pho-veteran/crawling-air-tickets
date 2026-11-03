import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {RemoteD1,worker} from './lib/worker-api.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import {canonicalJson,digest} from '../src/storage/d1.mjs';
import {query,providers} from '../src/worker/jobs.mjs';
import {queryId} from '../src/providers/vna-core.mjs';

const database=JSON.parse(await readFile('data/worker-database.json','utf8'));
const db=new RemoteD1(database.id),store=new RuntimeStore(db);
if((await worker('/health')).active)throw new Error('Pause Worker before compacting pricing.');
const pending=await store.statement("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')").first();
if(pending.n)throw new Error('Drain pending jobs before compacting pricing.');
const lease=await store.acquireLease('bot-runtime','compact:'+randomUUID(),{ttlMs:900000});
if(!lease)throw new Error('A consumer still owns the runtime lease; retry after it finishes.');
store.lease=lease;
try{
  const archive={schema:1,captured_at:new Date().toISOString(),database_id:database.id,tables:{}};
  // Full pricing backup includes everything written since the frozen local import.
  for(const table of ['observations','price_quotes','price_minima','legacy_documents']){
    const rows=[];let after=0;
    while(true){const page=(await store.statement('SELECT rowid AS archive_rowid,* FROM '+table+' WHERE rowid>? ORDER BY rowid LIMIT 500',after).all()).results;
      rows.push(...page);if(page.length<500)break;after=page.at(-1).archive_rowid;}
    archive.tables[table]=rows;
  }
  const file='data/worker-pricing-backup-'+Date.now()+'.json',bytes=canonicalJson(archive)+'\n';
  await writeFile(file,bytes);if(digest(await readFile(file))!==digest(bytes))throw new Error('Backup verification failed.');
  await writeFile(file+'.manifest.json',JSON.stringify({sha256:digest(bytes),verified:true,counts:Object.fromEntries(Object.entries(archive.tables).map(([k,v])=>[k,v.length]))},null,2)+'\n');
  const keys=[];
  for(const p of providers){
    const qid=queryId(query,p.source),current=await store.latest(p.source,qid);
    if(!current)throw new Error('Missing current provider record.');
    await store.observeCurrent(current);
    keys.push('current:'+p.source+':'+qid);
    // Only the prior verified Flynow Vietjet basis is compatible. Never transfer
    // neighboring-date minima or VNA matrix/untaxed calendar values to this basis.
    const compatible=archive.tables.observations.map(r=>JSON.parse(r.record_json)).filter(r=>
      p.id==='vietjet'&&r.source==='vietjet-flynow-airline-fare-v1'&&['ok','partial'].includes(r.status)&&r.taxes_included===true&&
      r.price_basis===current.price_basis&&['origin','destination','departureDate','returnDate','adults','currency'].every(k=>r.query[k]===query[k]));
    const candidates=new Map();
    for(const r of compatible){
      const legs=Object.fromEntries(['outbound','inbound'].map(l=>[l,(r.legs?.[l]||[]).filter(q=>q.date===(l==='outbound'?query.departureDate:query.returnDate))]));
      // Project only selected dimensions, without promoting historical quotes to current.
      for(const [kind,departure,back,price] of [['roundtrip',query.departureDate,query.returnDate,r.main_price],
        ['outbound',query.departureDate,'',legs.outbound[0]?.price],['inbound',query.returnDate,'',legs.inbound[0]?.price]]){
        if(!Number.isSafeInteger(price)||price<=0)continue;
        const old=candidates.get(kind);if(!old||price<old.price)candidates.set(kind,{kind,departure,back,price,at:r.observed_at,source:r.source});
      }
    }
    for(const c of candidates.values())await store.mutate(`INSERT INTO price_minima(basis_source,query_id,kind,departure_date,return_date,price,observed_ms,details_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(basis_source,query_id,kind,departure_date,return_date) DO UPDATE SET
      price=excluded.price,observed_ms=excluded.observed_ms,details_json=excluded.details_json WHERE excluded.price<price_minima.price`,
      p.source,qid,c.kind,c.departure,c.back,c.price,Date.parse(c.at),canonicalJson({price:c.price,compatible_source:c.source}));

  }
  await store.fencedBatch([
    store.statement('DELETE FROM observations WHERE id NOT IN (?,?)',...keys),
    store.statement('DELETE FROM price_quotes'),
    store.statement(`DELETE FROM price_minima WHERE NOT ((basis_source=? AND query_id=?) OR (basis_source=? AND query_id=?))
      OR NOT ((kind='roundtrip' AND departure_date=? AND return_date=?) OR (kind='outbound' AND departure_date=? AND return_date='') OR (kind='inbound' AND departure_date=? AND return_date=''))`,
      ...providers.flatMap(p=>[p.source,queryId(query,p.source)]),query.departureDate,query.returnDate,query.departureDate,query.returnDate),
    store.statement("UPDATE price_minima SET details_json=json_object('price',price)"),
    store.statement('DELETE FROM legacy_documents'),
    store.statement("UPDATE jobs SET body_json='{}' WHERE status='done'"),
    store.statement("UPDATE outbox SET message='',guards_json='[]' WHERE status IN ('sent','discarded')"),
  ]);
  const counts={};for(const table of ['observations','price_quotes','price_minima'])counts[table]=(await store.statement('SELECT COUNT(*) AS n FROM '+table).first()).n;
  if(counts.observations!==2||counts.price_quotes!==0||counts.price_minima!==6)throw new Error('Unexpected compact pricing counts; inspect backup before resuming.');
  const result={completed_at:new Date().toISOString(),verified:true,backup:file,counts,d1:db.totals};
  await writeFile('data/worker-pricing-compact-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await store.releaseLease(lease);}
