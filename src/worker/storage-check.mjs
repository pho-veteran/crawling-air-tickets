import sample from '../../scripts/fixtures/cloudflare-flynow-normalized.json' with {type:'json'};
import {D1Repository} from '../storage/d1.mjs';

function meter(db) {
  const totals={attempted_statements:0,successful_statements:0,failed_batches:0,rows_read:0,rows_written:0,d1_duration_ms:0};
  const count=result=>{totals.successful_statements++;totals.rows_read+=result.meta?.rows_read||0;totals.rows_written+=result.meta?.rows_written||0;totals.d1_duration_ms+=result.meta?.duration||0;return result;};
  const wrap=raw=>({_raw:raw,bind(...values){return wrap(raw.bind(...values));},
    async all(){totals.attempted_statements++;return count(await raw.all());},async run(){totals.attempted_statements++;return count(await raw.run());},
    async first(column){totals.attempted_statements++;const result=count(await raw.all()),row=result.results[0];return column?(row?.[column]??null):(row??null);},
  });
  return {totals,db:{prepare(sql){return wrap(db.prepare(sql));},async batch(statements){
    totals.attempted_statements+=statements.length;
    try{return (await db.batch(statements.map(s=>s._raw))).map(count);}catch(error){totals.failed_batches++;throw error;}
  }}};
}
const check=(condition,name)=>{if(!condition)throw new Error('Storage check failed: '+name);};

// Isolated synthetic data only. No provider fetch, Telegram call or private data.
export async function storageCheck(binding,runId) {
  const started=Date.now(),instrumented=meter(binding),repo=new D1Repository(instrumented.db);
  const source='storage-fixture-v1',queryId=runId,id='storage-check:'+runId,badId=id+':rollback';
  const chatId=String(parseInt(runId.replaceAll('-','').slice(0,12),16)||1),leaseKey=id+':lease';
  const record={...sample,source,query_id:queryId,legs_source:'storage-fixture-legs-v1'};
  const checks={};
  try {
    const first=await repo.putObservation(id,record),again=await repo.putObservation(id,record);
    check(first.inserted&&!again.inserted,'idempotent snapshot');checks.idempotent_snapshot=true;
    const page=await repo.historyPage({source,queryId});
    check(page.records.length===1&&page.records[0].main_price===sample.main_price,'history');checks.history=true;
    const key={basisSource:source,queryId,kind:'roundtrip',departure:sample.query.departureDate,back:sample.query.returnDate};
    check((await repo.minimum(key))?.price===sample.main_price,'minimum');checks.minimum=true;
    await repo.putSubscriber('1',chatId,{active:false,fixture:true,stoppedAt:1});
    await repo.putLegacyDocument(id,{schema:1,fixture:true,acknowledged:true},'a'.repeat(64));
    check((await repo.statement('SELECT active FROM subscribers WHERE bot_id=? AND chat_id=?','1',chatId).first())?.active===0,'opt-out');checks.opt_out=true;
    const lease=await repo.acquireLease(leaseKey,'first',{ttlMs:1});
    await new Promise(resolve=>setTimeout(resolve,5));
    const takeover=await repo.acquireLease(leaseKey,'second',{ttlMs:30000});
    check(takeover&&takeover.epoch===lease.epoch+1,'expired lease takeover');
    check(await repo.renewLease(lease)===null&&!await repo.releaseLease(lease),'stale lease owner');checks.lease_takeover=true;
    try {
      await instrumented.db.batch([
        repo.statement('INSERT INTO observations VALUES(?,?,?,?,?,?)',badId,source,queryId,1,'ok','{}'),
        repo.statement('INSERT INTO price_quotes VALUES(?,?,?,?,?,?,?,?,?)',badId,source,queryId,'roundtrip','2027-02-04','2027-02-13',0,1,'{}'),
      ]);
      throw new Error('Invalid quote unexpectedly persisted');
    } catch(error) {if(!/CHECK constraint/i.test(error.message))throw error;}
    check(await repo.statement('SELECT id FROM observations WHERE id=?',badId).first()===null,'batch rollback');checks.atomic_rollback=true;
    await repo.statement('DELETE FROM observations WHERE id=?',id).run();
    check((await repo.minimum(key))?.price===sample.main_price,'minimum survives history retention');checks.minimum_after_retention=true;
    check((await repo.statement('SELECT COUNT(*) AS n FROM price_quotes WHERE observation_id=?',id).first()).n===0,'foreign-key cleanup');checks.foreign_keys=true;
  } finally {
    await instrumented.db.batch([
      repo.statement('DELETE FROM observations WHERE id IN (?,?)',id,badId),
      repo.statement('DELETE FROM price_minima WHERE query_id=? AND basis_source IN (?,?)',queryId,source,'storage-fixture-legs-v1'),
      repo.statement('DELETE FROM subscribers WHERE bot_id=? AND chat_id=?','1',chatId),
      repo.statement('DELETE FROM legacy_documents WHERE namespace=?',id),
      repo.statement('DELETE FROM leases WHERE resource=?',leaseKey),
    ]);
  }
  const result={event:'storage_check_complete',run_id:runId,checks,wall_ms:Date.now()-started,
    input_bytes:new TextEncoder().encode(JSON.stringify(record)).byteLength,quotes:record.cells.length+record.legs.outbound.length+record.legs.inbound.length,
    d1:instrumented.totals,fixture:true,private_data_imported:false};
  console.log(JSON.stringify(result));return result;
}
