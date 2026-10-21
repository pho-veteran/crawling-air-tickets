import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import app,{consume,webhook} from '../src/worker/app.mjs';
import {query,providers,sendJob} from '../src/worker/jobs.mjs';
import {simulatedFlynow} from '../scripts/fixtures/flynow.mjs';
import {formatCurrentPrices} from '../src/monitoring/current-prices.mjs';
import {evaluateAlerts,defaults} from '../src/monitoring/alerts.mjs';

async function setup(t){
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());
  let clock=Date.now(),delivered=[],queued=[];const store=new RuntimeStore(DB,{now:()=>clock});
  await store.putState('control',{active:true});
  const env={DB,JOBS:{async send(b){queued.push(b);},async sendBatch(bs){queued.push(...bs.map(b=>b.body));}},
    TELEGRAM_BOT_TOKEN:'123:FAKE',BOT_USERNAME:'test',WEBHOOK_SECRET:'expected',ADMIN_SECRET:'admin'};
  const source=simulatedFlynow(query);
  const fetchImpl=async(url,opts)=>{
    if(url.includes('flynow'))return source.fetch(url,opts);
    delivered.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:delivered.length}});
  };
  const execute=async id=>{
    let ack=false,retry;await consume({body:{jobId:id},ack(){ack=true;},retry(r){retry=r;}},env,{fetchImpl,now:()=>clock});
    clock+=2500;return {ack,retry};
  };
  const drain=async()=>{for(let i=0;queued.length&&i<100;i++){const m=queued.shift();await execute(m.jobId);}assert.equal(queued.length,0);};
  return {DB,store,env,execute,drain,delivered,queued,source,now:()=>clock};
}
const request=(id,command='/price',chat=456,type='private')=>new Request('https://example.test/telegram',{method:'POST',
  headers:{'x-telegram-bot-api-secret-token':'expected'},body:JSON.stringify({update_id:id,message:{text:command,chat:{id:chat,type}}})});

test('shared group accepts member commands, ignores conversation/other groups, and stop cannot unsubscribe the group',async t=>{
  const x=await setup(t);await x.store.putState('shared-chat',{chatId:'-789'});
  await x.store.subscriber('123','-789','start');
  await webhook(request(1,'hello',-789,'group'),x.env,x.store);
  await webhook(request(2,'/price@other',-789,'group'),x.env,x.store);
  await webhook(request(3,'/price',-111,'supergroup'),x.env,x.store);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM jobs').first()).n,0);
  await webhook(request(4,'/price@test',-789,'group'),x.env,x.store);await x.drain();
  assert.equal(x.delivered.length,2);assert.ok(x.delivered.every(m=>String(m.chat_id)==='-789'));
  assert.match(x.delivered[0].text,/Đang kiểm tra/);assert.match(x.delivered[1].text,/Giá vé hiện tại/);
  await webhook(request(5,'/flights',-789,'supergroup'),x.env,x.store);await x.drain();
  assert.match(x.delivered.at(-1).text,/VN1469/);
  await webhook(request(6,'/stop',-789,'group'),x.env,x.store);await x.drain();
  assert.equal((await x.store.statement('SELECT active FROM subscribers WHERE chat_id=?','-789').first()).active,1);
  assert.match(x.delivered.at(-1).text,/không tắt bản tin/);
  await webhook(request(7,'/start'),x.env,x.store);await x.drain();
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM subscribers').first()).n,1);
});

test('shared broadcasts target only the group and suppress previously queued private notifications',async t=>{
  const x=await setup(t);await x.store.subscriber('123','456','start');await x.store.subscriber('123','-789','start');
  await x.store.putState('shared-chat',{chatId:'-789'});
  await x.store.queueText('old-private','456','old broadcast',{kind:'daily'});
  await x.store.createJob('shared-daily','daily',{day:'2026-10-13'});
  await x.execute('shared-daily');await x.drain();
  assert.equal((await x.store.statement('SELECT status FROM outbox WHERE id=?','old-private').first()).status,'discarded');
  assert.equal(x.delivered.length,1);assert.equal(String(x.delivered[0].chat_id),'-789');
});

test('Telegram group upgrade moves the configured destination and subscriber atomically',async t=>{
  const x=await setup(t);await x.store.putState('shared-chat',{chatId:'-789',title:'Flights'});await x.store.subscriber('123','-789','start');
  const update=new Request('https://example.test/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'expected'},
    body:JSON.stringify({update_id:10,message:{chat:{id:-789,type:'group'},migrate_to_chat_id:-100789}})});
  await webhook(update,x.env,x.store);
  assert.equal((await x.store.state('shared-chat')).chatId,'-100789');
  assert.equal((await x.store.statement('SELECT chat_id FROM subscribers').first()).chat_id,'-100789');
  await webhook(request(11,'/price',-100789,'supergroup'),x.env,x.store);await x.drain();
  assert.equal(x.delivered.length,2);assert.ok(x.delivered.every(m=>String(m.chat_id)==='-100789'));
});

test('webhook authentication and durable job/update/subscriber transaction precede ACK; duplicate updates do not duplicate jobs',async t=>{
  const x=await setup(t);
  assert.equal((await webhook(new Request('https://example.test/telegram',{method:'POST'}),x.env,x.store)).status,401);
  assert.equal((await webhook(request(1),x.env,x.store)).status,200);
  assert.equal((await webhook(request(1),x.env,x.store)).status,200);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM jobs').first()).n,1);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM telegram_updates').first()).n,1);
  const active=await x.store.statement('SELECT record_json FROM subscribers').first();assert.equal(JSON.parse(active.record_json).active,true);
  const unavailable={...x.env,JOBS:{async send(){throw new Error('queue');}}};
  assert.equal((await webhook(request(2),unavailable,x.store)).status,503);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM telegram_updates').first()).n,2);
});
test('real orchestration persists selected-date observations, replies /price and /flights, and survives duplicate delivery',async t=>{
  const x=await setup(t);
  await webhook(request(1),x.env,x.store);await x.execute('update:123:1');
  assert.equal(x.source.requests.length,0);assert.equal(x.delivered.length,0);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='crawl'").first()).n,0);
  const loading=await x.store.statement("SELECT id FROM jobs WHERE kind='send'").first();
  await x.execute(loading.id);assert.equal(x.source.requests.length,0);
  assert.match(x.delivered[0].text,/Đang kiểm tra giá mới hai hãng/);
  await x.drain();
  assert.equal(x.source.requests.length,2);assert.equal(x.delivered.length,2);
  assert.match(x.delivered[1].text,/\/flights/);
  await x.execute('update:123:1');assert.equal(x.delivered.length,2);
  await webhook(request(2,'/flights'),x.env,x.store);await x.drain();
  assert.equal(x.source.requests.length,4);assert.equal(x.delivered.length,4);
  assert.match(x.delivered[2].text,/Đang kiểm tra giờ bay và giá hai hãng/);
  assert.match(x.delivered[3].text,/VN1469/);assert.match(x.delivered[3].text,/VJ371/);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM observations').first()).n,2);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM price_quotes').first()).n,0);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM price_minima').first()).n,2);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE status='done' AND body_json<>'{}'").first()).n,0);
  for(const p of providers)assert.equal((await x.store.history(p.source,(await x.store.statement('SELECT query_id FROM observations WHERE source=?',p.source).first()).query_id)).length,1);
});

test('loading ACK replay recovers the crawl without resending loading or duplicating the follow-up',async t=>{
  const x=await setup(t),afterSend={id:'loading-follow-up',kind:'crawl',body:{silent:true,command:'price',chatId:'456'}};
  await x.store.queueText('loading-fixture','456','Đang kiểm tra...',{afterSend});
  x.store.lease=await x.store.acquireLease('bot-runtime','fixture',{ttlMs:300000});
  const create=x.store.createJob.bind(x.store);x.store.createJob=async()=>{throw new Error('follow-up write failed');};
  const job={body:{outboxId:'loading-fixture',afterSend}},deliver=async()=>{
    x.delivered.push('loading');return Response.json({ok:true,result:{message_id:1}});
  };
  await assert.rejects(sendJob(x.store,x.env,job,deliver),/follow-up write failed/);
  assert.equal((await x.store.statement('SELECT status FROM outbox WHERE id=?','loading-fixture').first()).status,'sent');
  x.store.createJob=create;await sendJob(x.store,x.env,job,deliver);await sendJob(x.store,x.env,job,deliver);
  assert.equal(x.delivered.length,1);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM jobs WHERE id=?',afterSend.id).first()).n,1);
});

test('rate-limited loading retries before any provider crawl is created',async t=>{
  const x=await setup(t);await webhook(request(1),x.env,x.store);await x.execute('update:123:1');
  const job=await x.store.statement("SELECT id FROM jobs WHERE kind='send'").first();let retry;
  await consume({body:{jobId:job.id},ack(){},retry(r){retry=r;}},x.env,{now:x.now,
    fetchImpl:async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:120}},{status:429})});
  assert.equal(retry.delaySeconds,120);assert.equal(x.source.requests.length,0);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='crawl'").first()).n,0);
});
test('stop is applied on durable receipt, stale start redelivery cannot undo opt-out, and manual requests still work',async t=>{
  const x=await setup(t);
  await webhook(request(10,'/start'),x.env,x.store);await webhook(request(12,'/stop'),x.env,x.store);
  await webhook(request(10,'/start'),x.env,x.store);
  assert.equal((await x.store.statement('SELECT active FROM subscribers').first()).active,0);
  await x.drain();assert.equal((await x.store.statement('SELECT active FROM subscribers').first()).active,0);
  await webhook(request(13,'/price'),x.env,x.store);await x.drain();assert.match(x.delivered.at(-1).text,/Giá vé hiện tại/);
  assert.equal((await x.store.statement('SELECT active FROM subscribers').first()).active,0);
});
test('an expired owner cannot commit state or snapshots after takeover; transaction leaves no child/minimum writes',async t=>{
  const x=await setup(t),old=await x.store.acquireLease('bot-runtime','old',{now:Date.now()-100,ttlMs:1});
  const lease=await x.store.acquireLease('bot-runtime','new',{ttlMs:300000});assert.ok(lease);
  x.store.lease=old;await assert.rejects(x.store.putState('bad',{active:true}));
  assert.deepEqual(await x.store.state('bad'),{});
  const record={schema:1,source:'fixture',query_id:'q',query,status:'ok',observed_at:new Date().toISOString(),main_price:100,cells:[]};
  await assert.rejects(x.store.observe('late',record));assert.equal(await x.store.statement('SELECT id FROM observations WHERE id=?','late').first(),null);
});
test('Telegram 429 sets durable global cooldown and retry; successful ACK prevents repeat sends',async t=>{
  const x=await setup(t);await x.store.queueText('manual-fixture','456','Test',{kind:'manual'});
  let attempts=0,retry;const msg={body:{jobId:'send:'+ (await import('../src/storage/d1.mjs')).digest('manual-fixture')},ack(){},retry(r){retry=r;}};
  await consume(msg,x.env,{now:x.now,fetchImpl:async()=>{attempts++;return Response.json({ok:false,error_code:429,parameters:{retry_after:120}},{status:429});}});
  assert.equal(attempts,1);assert.equal(retry.delaySeconds,120);
  const cooldown=await x.store.state('telegram-cooldown');assert.ok(cooldown.until>x.now());
  await consume(msg,x.env,{now:x.now,fetchImpl:async()=>{attempts++;throw new Error('must not send');}});assert.equal(attempts,1);
});
test('cron slot dedupe persists across redeploys; daily has its own fresh crawl and retention is bounded',async t=>{
  const x=await setup(t),controller={scheduledTime:Date.now(),cron:'*/10 * * * *'};
  await app.scheduled(controller,x.env);await app.scheduled(controller,x.env);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='crawl'").first()).n,1);
  await app.scheduled({...controller,cron:'0 0 * * *'},x.env);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='crawl'").first()).n,2);
});

test('current price replaces prior prices, minima only decrease, and errors preserve a clearly stale last good price',async t=>{
  const x=await setup(t),source='fixture',qid='q',query={...(await import('../src/worker/jobs.mjs')).query,trackingMode:'roundtrip'};
  const record=(total,at)=>({schema:1,source,query_id:qid,query,status:'ok',observed_at:at,main_price:total,cells:[],
    legs:{outbound:[{date:query.departureDate,price:total/2}],inbound:[{date:query.returnDate,price:total/2}]}});
  for(const [price,time] of [[100,'2026-10-12T00:00:00Z'],[120,'2026-10-12T00:10:00Z'],[80,'2026-10-12T00:20:00Z'],[110,'2026-10-12T00:30:00Z']])
    await x.store.observeCurrent(record(price,time));
  assert.equal((await x.store.latest(source,qid)).main_price,110);
  const minimum=await x.store.minimum({basisSource:source,queryId:qid,kind:'roundtrip',departure:query.departureDate,back:query.returnDate});
  assert.equal(minimum.price,80);
  await x.store.observeCurrent({...record(null,'2026-10-12T00:40:00Z'),status:'error',legs:{},error:'source unavailable'});
  const current=await x.store.latest(source,qid);assert.equal(current.main_price,110);assert.equal(current.last_attempt_failed,true);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM observations').first()).n,1);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM price_quotes').first()).n,0);
  assert.equal((await x.store.statement('SELECT COUNT(*) AS n FROM price_minima').first()).n,3);
  const text=formatCurrentPrices({providers:[{id:'vna',name:'VNA',history:[current],minimums:{main:80,outbound:40,inbound:40}}],query,now:Date.parse('2026-10-12T00:41:00Z'),onDemand:true});
  assert.match(text,/GIÁ CŨ/);assert.match(text,/tổng 80đ/);assert.doesNotMatch(text,/00:20|so với|%|7 ngày|timeline/);
  await x.store.observeCurrent(record(130,'2026-10-12T00:50:00Z'));
  assert.equal((await x.store.latest(source,qid)).last_attempt_failed,false);
});

test('minimum-only mode never claims rolling-window lows without a retained price timeline',()=>{
  const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
  const rec=(price,at,comparison_only=false)=>({status:'ok',source:'fixture',query,main_price:price,legs:{},observed_at:at,comparison_only});
  const history=[rec(100,'2026-09-01T00:00:00Z',true),rec(150,'2026-10-12T00:00:00Z')];
  const events=evaluateAlerts({id:'vna'},rec(140,'2026-10-13T00:00:00Z'),history,{initialized:true},{...defaults,historyMode:'current-and-minimum'});
  assert.match(events[0].text,/150đ/);assert.doesNotMatch(events[0].text,/ngày quan sát|từng thấy/);
});
