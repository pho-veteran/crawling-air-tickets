import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import {D1Repository,canonicalJson,observationModel} from '../src/storage/d1.mjs';
import {planImport,applyImport} from '../src/storage/import.mjs';
import {storageCheck} from '../src/worker/storage-check.mjs';

const at='2026-10-12T00:00:00.000Z';
const record=(price=100,source='fixture-vna',time=at)=>({schema:1,status:'ok',source,query_id:'fixture-query',
  query:{origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1},
  observed_at:time,main_price:price,cells:[{depart:'2027-02-04',return:'2027-02-13',state:'available',price}],
  legs_source:source+'-oneway',legs:{outbound:[{date:'2027-02-04',price:40,fare_family:null}],inbound:[{date:'2027-02-13',price:50,fare_family:null}]}});
async function database(t){const db=new LocalD1();await db.migrate();t.after(()=>db.close());return {db,repo:new D1Repository(db)};}
const input=records=>({'history.jsonl':{text:records.map(r=>JSON.stringify(r)).join('\n')},
  'telegram-subscribers.json':{text:JSON.stringify({schema:1,bots:{'123':{nextBroadcastAt:50,subscribers:{'456':{active:false,subscribedAt:1,stoppedAt:2},'789':{active:true,subscribedAt:1}}}}})},
  'notification-state.json':{text:JSON.stringify({schema:1,accounts:{opaque:{source:{sent:{event:1},pending:[{key:'pending',text:'Fixture price event',guard:{kind:'main',price:90}}],nextAttemptAt:500,attempts:2}}}})},
  'daily-state.json':{text:JSON.stringify({schema:1,entries:{opaque:{day:'2026-10-12',sent:true,messageId:12,messageVersion:2}}})},
  'bot-state.json':{text:JSON.stringify({schema:1,entries:{opaque:{offset:500,lastQuickAt:42}}})},
});

test('import preserves duplicates, errors, old identities, opt-outs and raw recipient ACKs; rerun is idempotent',async t=>{
  const {repo}=await database(t),error={...record(),status:'error',main_price:null,cells:[],legs:undefined};
  const plan=planImport(input([record(),record(),record(80,'old-source'),error]));
  assert.equal(plan.summary.observations,4);assert.equal(plan.summary.quotes,9);
  assert.equal(plan.summary.activeSubscribers,1);
  const first=await applyImport(repo,plan);assert.equal(first.insertedObservations,4);assert.equal(first.verified,true);
  assert.equal((await applyImport(repo,plan)).insertedObservations,0);
  const docs=await repo.statement('SELECT namespace,document_json FROM legacy_documents').all();
  for(const row of docs.results)assert.equal(row.document_json,canonicalJson(JSON.parse(input([])[row.namespace].text)));
  const history=await repo.historyPage({source:'fixture-vna',queryId:'fixture-query'});
  assert.equal(history.records.length,3);assert.equal(history.records.filter(r=>r.status==='error').length,1);
});
test('paged history handles equal timestamps and window/all-time minima remain isolated after retention',async t=>{
  const {repo}=await database(t);
  await repo.putObservation('a',record(90));await repo.putObservation('b',record(80));
  await repo.putObservation('c',record(70,'old-source'));
  await repo.putObservation('d',record(100,'fixture-vna','2026-10-13T00:00:00.000Z'));
  const page=await repo.historyPage({source:'fixture-vna',queryId:'fixture-query',limit:1});
  const next=await repo.historyPage({source:'fixture-vna',queryId:'fixture-query',limit:1,after:page.cursor});
  assert.equal(page.records[0].main_price,90);assert.equal(next.records[0].main_price,80);
  const key={basisSource:'fixture-vna',queryId:'fixture-query',kind:'roundtrip',departure:'2027-02-04',back:'2027-02-13'};
  assert.equal((await repo.minimum(key)).price,80);
  assert.equal((await repo.minimum({...key,fromMs:Date.parse('2026-10-13'),throughMs:Date.parse('2026-10-14')})).price,100);
  assert.equal(await repo.pruneBefore(Date.parse('2026-10-13')),3);
  assert.equal((await repo.minimum(key)).price,80);
  assert.equal((await repo.minimum({...key,fromMs:Date.parse(at),throughMs:Date.parse('2026-10-12T23:59:00Z')})),null);
  assert.equal((await repo.historyPage({source:'fixture-vna',queryId:'fixture-query'})).records.length,1);
});
test('atomic SQL batch rolls back parent insert when a child quote violates a constraint',async t=>{
  const {repo,db}=await database(t);
  await assert.rejects(db.batch([
    repo.statement(`INSERT INTO observations VALUES(?,?,?,?,?,?)`,'bad','fixture','query',1,'ok','{}'),
    repo.statement(`INSERT INTO price_quotes VALUES(?,?,?,?,?,?,?,?,?)`,'bad','fixture','query','roundtrip','2027-02-04','2027-02-13',0,1,'{}'),
  ]));
  assert.equal(await repo.statement('SELECT id FROM observations WHERE id=?','bad').first(),null);
});
test('lease acquisition is atomic, expiry permits takeover, and stale epochs cannot renew or release',async t=>{
  const {repo}=await database(t);
  const competing=await Promise.all(['first','second'].map(owner=>repo.acquireLease('crawl',owner,{now:1000,ttlMs:100})));
  assert.equal(competing.filter(Boolean).length,1);const original=competing.find(Boolean);
  assert.equal(await repo.acquireLease('crawl','next',{now:1099,ttlMs:100}),null);
  const takeover=await repo.acquireLease('crawl','next',{now:1100,ttlMs:100});assert.equal(takeover.epoch,2);
  assert.equal(await repo.renewLease(original,{now:1101,ttlMs:100}),null);assert.equal(await repo.releaseLease(original),false);
  assert.equal(await repo.renewLease(takeover,{now:1200,ttlMs:100}),null);
  assert.equal(await repo.releaseLease(takeover),true);assert.equal(await repo.releaseLease(takeover),false);
  const reused=await repo.acquireLease('crawl','next',{now:1201,ttlMs:100});assert.equal(reused.epoch,3);
  assert.equal(await repo.releaseLease(takeover),false);
});
test('invalid history fails before writes, ID collisions preserve data and changed destinations are rejected',async t=>{
  const {repo}=await database(t);
  assert.throws(()=>planImport(input([record(),{...record(),main_price:0}])));
  assert.throws(()=>planImport({'history.jsonl':{text:'{broken'}}));
  assert.deepEqual(JSON.parse(canonicalJson({optional:undefined,arr:[undefined]})),{arr:[null]});
  await repo.putObservation('same',record());await assert.rejects(repo.putObservation('same',record(90)),/collision/);
  assert.equal((await repo.historyPage({source:'fixture-vna',queryId:'fixture-query'})).records[0].main_price,100);
  await assert.rejects(applyImport(repo,planImport(input([record(80)]))),/different observations/);
  assert.throws(()=>observationModel({...record(),cells:[...record().cells,...record().cells]}),/Duplicate/);
});
test('changed subscriber opt-out or cooldown/ACK state aborts before further import',async t=>{
  const {repo}=await database(t),plan=planImport(input([record()]));await applyImport(repo,plan);
  await repo.putSubscriber('123','789',{active:false,stoppedAt:100});
  await assert.rejects(applyImport(repo,plan),/opt-outs/);
  await repo.putSubscriber('123','789',{active:true,subscribedAt:1});
  const changedInputs=input([record(),record(80)]);changedInputs['notification-state.json'].text=JSON.stringify({schema:1,accounts:{}});
  await assert.rejects(applyImport(repo,planImport(changedInputs)),/legacy state differs/);
  assert.equal((await repo.statement('SELECT COUNT(*) AS n FROM observations').first()).n,1);
});
test('the remote storage diagnostic logic verifies a realistic payload and cleans all of its fixture rows',async t=>{
  const {db,repo}=await database(t);
  const result=await storageCheck(db,'00000000-0000-4000-8000-000000000001');
  assert.ok(Object.values(result.checks).every(Boolean));assert.equal(result.quotes,63);
  assert.ok(result.d1.attempted_statements<=50);assert.equal(result.d1.failed_batches,1);
  for(const table of ['observations','price_quotes','price_minima','subscribers','legacy_documents','leases'])
    assert.equal((await repo.statement('SELECT COUNT(*) AS n FROM '+table).first()).n,0);
});
