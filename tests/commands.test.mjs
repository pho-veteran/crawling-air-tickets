import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {handleCommand} from '../lib/commands.mjs';
import {sendDocument} from '../lib/telegram.mjs';
import {sendDaily} from '../lib/daily.mjs';
import {settingsFrom,evaluateAlerts,formatAlert,alertGroups,stillRelevant} from '../lib/alerts.mjs';
import {morningAt,nextMorning,formatDaily} from '../lib/messages.mjs';
import {createBatch} from '../lib/batch.mjs';
import {notifyRecord} from '../lib/notify.mjs';
const creds={token:'123:TEST_SECRET',chatId:'456',configured:true,enabled:true};
const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const settings=settingsFrom({},{}),record={query,status:'ok',source:'test',observed_at:'2026-10-12T00:00:00Z',main_price:5000000,minimum_price:3000000,cells:[{depart:'2027-02-05',return:'2027-02-15',price:3000000}],legs:{outbound:[{date:query.departureDate,price:2000000}],inbound:[{date:query.returnDate,price:3000000}]}};
const providers=[{id:'vna',name:'Vietnam Airlines',history:[record]},{id:'vietjet',name:'Vietjet',history:[record]}];
const temp=()=>mkdtemp(path.join(os.tmpdir(),'fare-command-test-'));
function harness(){const messages=[],documents=[],state={};let runs=0,saves=0,clock=Date.parse(record.observed_at);return {messages,documents,state,get runs(){return runs;},get saves(){return saves;},args:{root:'unused',creds,state,now:()=>clock,save:async()=>saves++,busy:async()=>false,context:async()=>({providers,query,settings}),report:async()=>'/report.html',send:async(c,t)=>{messages.push(t);return messages.length;},attach:async(c,f)=>{documents.push(f);return 1;},call:async()=>({is_bot:true}),quick:async()=>{runs++;clock+=1250;return 0;}}};}
const update=(text,id=456)=>({message:{text,chat:{id,type:'private'}}});
test('slash authorization, help, unknown and connection do not crawl',async()=>{
  const h=harness();assert.equal((await handleCommand({...h.args,update:update('/price',789)})).status,'ignored');
  assert.equal((await handleCommand({...h.args,update:update('/price@other'),username:'mine'})).status,'ignored');
  for(const cmd of ['/help','/start','/status','/connection','/oops'])await handleCommand({...h.args,update:update(cmd)});
  assert.equal(h.runs,0);assert.equal(h.messages.length,5);assert.match(h.messages[2],/07:00 UTC\+07:00/);
});
test('price refresh persists cooldown, sends one combined digest plus report, repeat/busy uses cache',async()=>{
  const h=harness();const first=await handleCommand({...h.args,update:update('/price')});
  assert.equal(first.elapsed_ms,1250);assert.equal(h.runs,1);assert.equal(h.saves,1);assert.equal(h.documents.length,1);
  assert.match(h.messages[0],/VIETNAM AIRLINES/);assert.match(h.messages[0],/VIETJET/);assert.doesNotMatch(h.messages[0],/05\/02|15\/02|3.000.000đ.*Lân cận/);
  await handleCommand({...h.args,update:update('/price')});assert.equal(h.runs,1);assert.match(h.messages[1],/trong phút này/);
  await handleCommand({...h.args,update:update('/price'),busy:async()=>true});assert.equal(h.runs,1);assert.match(h.messages[2],/lượt tự động/);
  await handleCommand({...h.args,update:update('/report')});assert.equal(h.documents.length,4);assert.equal(h.runs,1);
});
test('partial quick result states incomplete instead of claiming complete',async()=>{
  const h=harness();await handleCommand({...h.args,update:update('/price'),quick:async()=>2});assert.match(h.messages[0],/chưa cập nhật đủ/);assert.doesNotMatch(h.messages[0],/Vừa kiểm tra xong/);
});
test('schedule is configured in env and obeys date boundary and offset',()=>{
  const s=settingsFrom({},{DAILY_REPORT_TIME:'23:15',DAILY_REPORT_UTC_OFFSET:'-03:30'}),at=Date.parse('2026-10-12T00:00:00Z');
  assert.equal(morningAt(at,s),Date.parse('2026-10-12T02:45:00Z'));assert.equal(nextMorning(at,s),morningAt(at,s));
  assert.throws(()=>settingsFrom({},{DAILY_REPORT_TIME:'25:00'}));assert.throws(()=>settingsFrom({},{DAILY_REPORT_UTC_OFFSET:'+14:30'}));
});
test('daily attachment retries without re-sending acknowledged text; date is not delivered prematurely',async()=>{
  const root=await temp(),now=Date.parse(record.observed_at);let texts=0,docs=0,reports=0;
  const args={root,providers,query,settings,creds,now,send:async()=>++texts,report:async()=>{reports++;return 'fixture.html';},attach:async()=>{if(++docs===1)throw new Error();return 2;}};
  assert.equal((await sendDaily(args)).status,'send_failed');assert.equal(texts,1);
  assert.equal((await sendDaily({...args,now:now+300001})).status,'sent');assert.equal(texts,1);assert.equal(docs,2);assert.equal(reports,1);
  assert.equal((await sendDaily({...args,now:now+600000})).status,'already_sent');
});
test('HTML is uploaded as multipart document and acknowledgement is required',async()=>{
  const root=await temp(),file=path.join(root,'report.html');await writeFile(file,'<!doctype html><h1>Report</h1>');
  const id=await sendDocument(creds,file,'📊 Báo cáo',async(url,opts)=>{assert.ok(url.endsWith('/sendDocument'));assert.ok(opts.body instanceof FormData);assert.equal(opts.body.get('chat_id'),'456');assert.match(await opts.body.get('document').text(),/Report/);assert.equal(opts.headers,undefined);return {ok:true,json:async()=>({ok:true,result:{message_id:99}})};});assert.equal(id,99);
});
test('quick mode has no pacing sleep, expires at 8s, keeps host cooldown',async()=>{
  const root=await temp();let clock=0;const opts={root,seconds:8,quick:true,now:()=>clock,sleep:async()=>{throw new Error('Must not sleep');},fetchImpl:async()=>{clock+=1000;return new Response('{}');}};
  const b=await createBatch(opts);for(let i=0;i<5;i++)await b.fetch('https://example.test');assert.equal((await b.finish()).duration_ms,5000);clock=8000;await assert.rejects(b.fetch('https://example.test'),/Hết ngân sách/);
  const failed=await createBatch({...opts,fetchImpl:async()=>new Response('',{status:429})});await failed.fetch('https://example.test');const retry=await createBatch(opts);await assert.rejects(retry.fetch('https://example.test'),/Nguồn đang nghỉ/);
});
test('neighbor-only decreases stay silent; main RT/outbound/inbound become three concise events',()=>{
  const p=providers[0],a=structuredClone(record),b=structuredClone(record);b.observed_at='2026-10-12T00:25:00Z';b.minimum_price=1;b.cells[0].price=1;b.legs.outbound.push({date:'2027-02-05',price:1});a.legs.outbound.push({date:'2027-02-05',price:5000000});
  assert.deepEqual(evaluateAlerts(p,b,[a],{initialized:true},settings),[]);
  assert.equal(stillRelevant({guard:{kind:'minimum',price:1}},b),false);
  b.main_price-=100000;b.legs.outbound[0].price-=50000;b.legs.inbound[0].price-=50000;
  const groups=alertGroups(evaluateAlerts(p,b,[a],{initialized:true},settings));assert.equal(groups.length,3);
  for(const g of groups){const text=formatAlert(p,b,g,[a]);assert.ok(text.length<1600);assert.match(text,/Giá vé vừa giảm/);assert.doesNotMatch(text,/05\/02|15\/02/);}
  assert.doesNotMatch(formatDaily({providers:[{...p,history:[b]}],query,now:Date.parse(b.observed_at)}),/05\/02|15\/02/);
});
test('one event per message; retry resumes only the unacknowledged event',async()=>{
  const root=await temp(),provider=providers[0],a=structuredClone(record),b=structuredClone(record);b.observed_at='2026-10-12T00:25:00Z';b.main_price-=100000;b.legs.outbound[0].price-=50000;b.legs.inbound[0].price-=50000;
  const args={root,provider,settings,creds};
  await notifyRecord({...args,record:a,history:[],now:0,send:async()=>1});let n=0;const messages=[];
  const failed=await notifyRecord({...args,record:b,history:[a],now:1500000,send:async(c,t)=>{messages.push(t);if(++n===2)throw new Error();return 2;}});
  assert.equal(failed.status,'send_failed');assert.equal(messages.length,2);
  const retry=[];const result=await notifyRecord({...args,record:b,history:[a],now:1560001,send:async(c,t)=>{retry.push(t);return 3;}});
  assert.equal(result.status,'sent');assert.equal(retry.length,2);assert.ok(retry.every(t=>!t.includes('Khứ hồi hiện là')));assert.ok(retry.some(t=>t.includes('Vé đi')));assert.ok(retry.some(t=>t.includes('Vé về')));
});
