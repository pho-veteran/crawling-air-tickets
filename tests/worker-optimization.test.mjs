import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import app,{consume,webhook,dispatch} from '../src/worker/app.mjs';
import {query} from '../src/worker/jobs.mjs';
import {admit,requestRefresh,attachRefresh,completeRefresh} from '../src/worker/interactive.mjs';
import {simulatedFlynow} from '../scripts/fixtures/flynow.mjs';

async function fixture(t){
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());let clock=Date.now();
  const store=new RuntimeStore(DB,{now:()=>clock}),queue=[],sent=[],source=simulatedFlynow(query);
  await store.putState('control',{active:true});await store.putState('shared-chat',{chatId:'-123'});await store.subscriber('123','-123','start');
  const env={DB,OPTIMIZED:'1',TELEGRAM_BOT_TOKEN:'123:fake',BOT_USERNAME:'test',WEBHOOK_SECRET:'secret',JOBS:{async send(b){queue.push(b);},async sendBatch(bs){queue.push(...bs.map(b=>b.body));}}};
  const fetchImpl=async(url,opts)=>{if(url.includes('flynow'))return source.fetch(url,opts);sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:sent.length}});};
  const run=async id=>{let retried;await consume({body:{jobId:id},ack(){},retry(r){retried=r;}},env,{fetchImpl,now:()=>clock});clock+=2500;if(retried){clock+=retried.delaySeconds*1000;queue.push({jobId:id});}};
  const drain=async()=>{for(let n=0;queue.length&&n<100;n++)await run(queue.shift().jobId);assert.equal(queue.length,0);};
  const input=async(id,text)=>webhook(new Request('https://test/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({update_id:id,message:{text,chat:{type:'group',id:-123},from:{id:100+id}}})}),env,store);
  return {DB,store,env,queue,sent,source,run,drain,input,advance:ms=>clock+=ms,now:()=>clock};
}

test('simultaneous group price/flights commands share one crawl and duplicate commands share one response',async t=>{
  const x=await fixture(t);
  await x.input(1,'/price');await x.input(2,'/price');await x.input(3,'/flights');
  await x.drain();
  assert.equal(x.source.requests.length,2);assert.equal(x.sent.length,4);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM interactive").first()).n,2);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh'").first()).n,1);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM interactive WHERE completed_ms IS NULL").first()).n,0);
  assert.match(x.sent.map(m=>m.text).join('\n'),/VN1468/);
  await x.input(1,'/price');await x.drain();assert.equal(x.sent.length,4);
});

test('fresh cache avoids source fetches; expired cache requests a new refresh',async t=>{
  const x=await fixture(t);await requestRefresh(x.store,'initial',{force:true});await dispatch(x.store,x.env);await x.drain();
  assert.equal(x.source.requests.length,2);
  await x.input(1,'/price');await x.drain();assert.equal(x.source.requests.length,2);
  x.advance(31000);await x.input(2,'/price');await x.drain();assert.equal(x.source.requests.length,4);
});

test('cron and a user join the same active refresh; daily cron survives joining',async t=>{
  const x=await fixture(t);await x.input(1,'/price');await x.run(x.queue.shift().jobId);
  await app.scheduled({scheduledTime:x.now(),cron:'0 0 * * *'},x.env);await x.drain();
  assert.equal(x.source.requests.length,2);
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

test('completion racing with join still queues a response, errors never become valid cache',async t=>{
  const x=await fixture(t);const req=await admit(x.store,'123',1,{chatId:'-123',command:'price'});
  await requestRefresh(x.store,'race',{force:true});await completeRefresh(x.store,'race',false);
  await attachRefresh(x.store,req.id);
  const cache=await x.store.state('refresh-cache');assert.equal(cache.valid,false);
  assert.equal((await x.store.statement("SELECT COUNT(*) AS n FROM jobs WHERE kind='refresh' AND status='pending'").first()).n,1);
});
