import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import app,{consume,webhook,dispatch} from '../src/worker/app.mjs';
import {query} from '../src/worker/jobs.mjs';
import {admit,requestRefresh,attachRefresh,completeRefresh,fastLoading} from '../src/worker/interactive.mjs';
import {simulatedSources as simulatedFlynow} from '../scripts/fixtures/agencies.mjs';

async function fixture(t){
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());let clock=Date.now();
  const store=new RuntimeStore(DB,{now:()=>clock}),queue=[],sent=[],source=simulatedFlynow(query);
  await store.putState('control',{active:true});await store.putState('shared-chat',{chatId:'-123'});await store.subscriber('123','-123','start');
  const env={DB,OPTIMIZED:'1',TELEGRAM_BOT_TOKEN:'123:fake',BOT_USERNAME:'test',WEBHOOK_SECRET:'secret',JOBS:{async send(b){queue.push(b);},async sendBatch(bs){queue.push(...bs.map(b=>b.body));}}};
  const fetchImpl=async(url,opts)=>{if(/flynow|bestprice|abay/.test(url))return source.fetch(url,opts);sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:sent.length}});};
  const run=async id=>{let retried;await consume({body:{jobId:id},ack(){},retry(r){retried=r;}},env,{fetchImpl,now:()=>clock});clock+=2500;if(retried){clock+=retried.delaySeconds*1000;queue.push({jobId:id});}};
  const drain=async()=>{for(let n=0;queue.length&&n<100;n++)await run(queue.shift().jobId);assert.equal(queue.length,0);};
  const input=async(id,text)=>webhook(new Request('https://test/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({update_id:id,message:{text,chat:{type:'group',id:-123},from:{id:100+id}}})}),env,store);
  return {DB,store,env,queue,sent,source,run,drain,input,fetchImpl,advance:ms=>clock+=ms,now:()=>clock};
}

test('simultaneous group price/flights commands share one crawl and duplicate commands share one response',async t=>{
  const x=await fixture(t);
  await x.input(1,'/price');await x.input(2,'/price');await x.input(3,'/flights');
  await x.drain();
  assert.equal(x.source.requests.length,9);assert.equal(x.sent.length,4);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM interactive").first()).n,2);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").first()).n,1);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM interactive WHERE completed_ms IS NULL").first()).n,0);
  assert.match(x.sent.map(m=>m.text).join('\n'),/VN1469/);
  await x.input(1,'/price');await x.drain();assert.equal(x.sent.length,4);
});

test('fresh cache avoids source fetches; expired cache requests a new refresh',async t=>{
  const x=await fixture(t);await requestRefresh(x.store,'initial',{force:true});await dispatch(x.store,x.env);await x.drain();
  assert.equal(x.source.requests.length,9);
  await x.input(1,'/price');await x.drain();assert.equal(x.source.requests.length,9);
  x.advance(31000);await x.input(2,'/price');await x.drain();assert.equal(x.source.requests.length,18);
});

test('cron and a user join the same active refresh; daily cron survives joining',async t=>{
  const x=await fixture(t);await x.input(1,'/price');await x.run(x.queue.shift().jobId);
  await app.scheduled({scheduledTime:x.now(),cron:'0 0 * * *'},x.env);await x.drain();
  assert.equal(x.source.requests.length,9);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").first()).n,1);
  assert.ok(x.sent.some(m=>m.text.includes('Giá vé hôm nay')));
});

test('admission atomically caps accepted requests at 200/day; rejects create no jobs; next UTC day resets',async t=>{
  const x=await fixture(t);
  for(let i=0;i<202;i++)await admit(x.store,'123',i,{chatId:String(i+1),command:'price',optimized:true});
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM interactive').first()).n,200);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM jobs').first()).n,200);
  assert.equal(await admit(x.store,'123',999,{chatId:'999',command:'price'}),null);
  await app.scheduled({scheduledTime:x.now(),cron:'*/10 * * * *'},x.env);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").first()).n,1);
  x.advance(86400000);assert.ok(await admit(x.store,'123',1000,{chatId:'1000',command:'price'}));
});

test('delayed 07:00 cron sends once even after the shared poll completed and its cache expired',async t=>{
  const x=await fixture(t),slot=x.now();
  await app.scheduled({scheduledTime:slot,cron:'*/10 * * * *'},x.env);await x.drain();
  assert.equal(x.source.requests.length,9);assert.equal(x.sent.length,0);
  x.advance(60000);
  await app.scheduled({scheduledTime:slot,cron:'0 0 * * *'},x.env);await x.drain();
  assert.equal(x.source.requests.length,9);assert.equal(x.sent.length,1);
  assert.match(x.sent[0].text,/Giá vé hôm nay/);assert.match(x.sent[0].text,/VIETNAM AIRLINES/);
  await app.scheduled({scheduledTime:slot,cron:'0 0 * * *'},x.env);await x.drain();
  assert.equal(x.sent.length,1);
});

test('daily delivery waits for its refresh, then sends a fresh quote even if delivery lane runs first',async t=>{
  const x=await fixture(t);x.env.DELIVERY=x.env.JOBS;
  await app.scheduled({scheduledTime:x.now(),cron:'0 0 * * *'},x.env);
  const daily=await x.store.statement("SELECT id FROM jobs WHERE kind='daily'").first();
  await x.run(daily.id);assert.equal(x.sent.length,0);
  const pending=await x.store.statement('SELECT status,attempts FROM jobs WHERE id=?',daily.id).first();
  assert.equal(pending.status,'pending');assert.equal(pending.attempts,0);
  await x.drain();assert.equal(x.sent.length,1);assert.equal(x.source.requests.length,9);
  assert.doesNotMatch(x.sent[0].text,/Chưa cập nhật được giá hiện tại|GIÁ CŨ/);
});

test('daily report marks VNA stale when the agency rejects a search, while sending the successful provider',async t=>{
  const x=await fixture(t);
  await requestRefresh(x.store,'last-good',{force:true});await dispatch(x.store,x.env);await x.drain();
  x.advance(60000);
  await app.scheduled({scheduledTime:x.now(),cron:'0 0 * * *'},x.env);
  const refresh=await x.store.statement("SELECT id FROM jobs WHERE kind='refresh' AND status='pending'").first();
  await consume({body:{jobId:refresh.id},ack(){},retry(){assert.fail('source errors should complete with stale data');}},x.env,{now:x.now,
    fetchImpl:async(url,opts)=>/bestprice|abay/.test(url)?
      Response.json({Message:'PRIVATE_SUPPLIER_TEXT',Session:'PRIVATE_SESSION'},{status:503}):x.fetchImpl(url,opts)});
  await x.drain();assert.equal(x.sent.length,1);
  const [vna,vietjet]=x.sent[0].text.split('🟥 VIETJET');
  assert.match(vna,/VIETNAM AIRLINES[\s\S]*GIÁ CŨ/);assert.doesNotMatch(vietjet,/GIÁ CŨ/);
  const stale=await x.store.statement("SELECT record_json FROM observations WHERE source LIKE 'vna-%'").first();
  assert.match(JSON.parse(stale.record_json).last_attempt_error,/BestPrice and ABAY/);
  assert.doesNotMatch(stale.record_json,/PRIVATE_SUPPLIER_TEXT|PRIVATE_SESSION/);
});

test('completion racing with join still queues a response, errors never become valid cache',async t=>{
  const x=await fixture(t);const req=await admit(x.store,'123',1,{chatId:'-123',command:'price'});
  await requestRefresh(x.store,'race',{force:true});await completeRefresh(x.store,'race',false);
  await attachRefresh(x.store,req.id);
  const cache=await x.store.state('refresh-cache');assert.equal(cache.valid,false);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh' AND status='pending'").first()).n,1);
});

test('completed successful refresh can be joined without a lost reply or another fetch',async t=>{
  const x=await fixture(t),req=await admit(x.store,'123',1,{chatId:'-123',command:'price'});
  await requestRefresh(x.store,'race',{force:true});await completeRefresh(x.store,'race',true);
  await attachRefresh(x.store,req.id);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").first()).n,1);
  assert.ok(await x.store.statement('SELECT id FROM jobs WHERE id=?',req.id+':reply').first());
});

test('fast loading is ACKed once before command consumption, replay does not resend',async t=>{
  const x=await fixture(t),req=await admit(x.store,'123',1,{chatId:'-123',command:'price',optimized:true});
  assert.equal(await fastLoading(x.store,x.env,req.id,x.fetchImpl),true);
  assert.equal(await fastLoading(x.store,x.env,req.id,x.fetchImpl),true);
  assert.equal(x.sent.length,1);assert.equal(x.source.requests.length,0);
  await dispatch(x.store,x.env);await x.drain();assert.equal(x.sent.length,2);assert.equal(x.source.requests.length,9);
});

test('Telegram 429 or held delivery lane cannot block the scheduled crawl lane',async t=>{
  const x=await fixture(t);x.env.DELIVERY=x.env.JOBS;
  const req=await admit(x.store,'123',1,{chatId:'-123',command:'price'});
  assert.equal(await fastLoading(x.store,x.env,req.id,async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:120}})),false);
  const held=await x.store.acquireLease('delivery-runtime','test',{now:x.now(),ttlMs:300000});assert.ok(held);
  await app.scheduled({scheduledTime:x.now(),cron:'*/10 * * * *'},x.env);
  const job=await x.store.statement("SELECT id FROM jobs WHERE kind='refresh'").first();await x.run(job.id);
  assert.equal(x.source.requests.length,9);assert.equal(x.sent.length,0);
  assert.equal((await x.store.statement('SELECT status FROM jobs WHERE id=?',job.id).first()).status,'done');
});

test('dispatcher claims jobs once across lanes and releases claims on enqueue failure',async t=>{
  const x=await fixture(t);await x.store.createJob('a','refresh',{});await x.store.createJob('b','command',{});
  const crawl=[],delivery=[];x.env.JOBS={async sendBatch(bs){crawl.push(...bs);}};x.env.DELIVERY={async sendBatch(bs){delivery.push(...bs);}};
  await dispatch(x.store,x.env);await dispatch(x.store,x.env);assert.equal(crawl.length,1);assert.equal(delivery.length,1);
  await x.store.createJob('c','command',{});x.env.DELIVERY={async sendBatch(){throw new Error('offline');}};
  await assert.rejects(dispatch(x.store,x.env),/offline/);
  assert.equal((await x.store.statement("SELECT queued_ms FROM jobs WHERE id='c'").first()).queued_ms,0);
});

test('alert budget caps at 60 messages/day without restricting manual replies or new-day alerts',async t=>{
  const x=await fixture(t);
  for(let i=0;i<65;i++)await x.store.queueText('a'+i,'-123','alert',{kind:'alert'});
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM outbox').first()).n,60);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM jobs').first()).n,60);
  await x.store.queueText('manual','-123','price');assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM outbox').first()).n,61);
  x.advance(86400000);await x.store.queueText('nextday','-123','alert',{kind:'alert'});
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM outbox').first()).n,62);
});

test('fresh result is sent without a delivery queue hop and the crawl lease is released first',async t=>{
  const x=await fixture(t);x.env.DELIVERY=x.env.JOBS;
  await x.input(1,'/price');await x.run(x.queue.shift().jobId);
  const refresh=await x.store.statement("SELECT id FROM jobs WHERE kind='refresh'").first();
  let replySent=false;
  await consume({body:{jobId:refresh.id},ack(){},retry(){assert.fail('unexpected retry');}},x.env,{now:x.now,fetchImpl:async(url,options)=>{
    if(url.includes('api.telegram')){
      assert.equal((await x.store.statement("SELECT expires_ms FROM leases WHERE resource='crawl-runtime'").first()).expires_ms,0);
      replySent=true;
    }
    return x.fetchImpl(url,options);
  }});
  assert.equal(replySent,true);
  assert.ok((await x.store.statement('SELECT completed_ms FROM interactive').first()).completed_ms);
});
