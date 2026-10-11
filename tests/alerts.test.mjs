import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {evaluateAlerts,settingsFrom,stillRelevant,formatAlert} from '../lib/alerts.mjs';
import {notifyRecord} from '../lib/notify.mjs';
import {telegramCall} from '../lib/telegram.mjs';
const settings=settingsFrom(),provider={id:'vna',name:'Vietnam Airlines',source:'test-vna'};
const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
function snapshot(n,price=5000000,min=4000000){return {source:provider.source,query_id:'test',query,status:'ok',observed_at:new Date(Date.UTC(2026,9,11,0,n)).toISOString(),main_price:price,minimum_price:min,cells:[{depart:query.departureDate,return:query.returnDate,price},{depart:'2027-02-05',return:'2027-02-15',price:min}]};}
const evaluate=(r,h=[],s={initialized:true})=>evaluateAlerts(provider,r,h,s,settings);
test('baseline, unchanged, one-dong drop and genuine lows',()=>{
  const a=snapshot(0),b=snapshot(25),c=snapshot(50,4999999);
  assert.ok(evaluate(a,[],{}).some(e=>e.key==='baseline'));
  assert.equal(evaluate(a,[],{}).some(e=>e.text.includes('Đáy mới')),false);
  assert.deepEqual(evaluate(b,[a]),[]);
  assert.match(evaluate(c,[a,b]).find(e=>e.key.startsWith('main:')).text,/Giảm 1đ.*thấp nhất mình từng thấy/);
});
test('error is not zero price; three failures then one recovery',()=>{
  const a=snapshot(0),err=n=>({...snapshot(n),status:'error',main_price:null,minimum_price:null,cells:[]});
  assert.deepEqual(evaluate(err(25),[a]),[]);
  assert.deepEqual(evaluate(err(50),[a,err(25)]),[]);
  assert.equal(evaluate(err(75),[a,err(25),err(50)])[0].key,'error');
  assert.deepEqual(evaluate(err(100),[err(25),err(50),err(75)],{initialized:true,incidentOpen:true}),[]);
  assert.ok(evaluate(snapshot(125),[a,err(25)],{initialized:true,incidentOpen:true}).some(e=>e.key==='recovery'));
});
test('rolling low, budget crossing, flexible dates and Eco label',()=>{
  const old={...snapshot(0,3000000),observed_at:'2026-09-01T00:00:00.000Z'},a=snapshot(0),b=snapshot(25,4500000);
  const text=evaluate(b,[old,a]).find(e=>e.key.startsWith('main:')).text;
  assert.match(text,/7 ngày/);assert.doesNotMatch(text,/Đáy mới của toàn bộ/);
  const budget=settingsFrom({targetVnd:{vna:4600000}});
  assert.match(evaluateAlerts(provider,b,[a],{initialized:true},budget).find(e=>e.key.startsWith('main:')).text,/chạm ngân sách/);
  assert.deepEqual(evaluate(snapshot(25,5000000,3500000),[snapshot(0,5000000,4800000)]),[]);
  a.legs={outbound:[{date:query.departureDate,fare_family:'SkyBoss'}]};b.legs={outbound:[{date:query.departureDate,fare_family:'Eco'}]};
  assert.ok(evaluate(b,[a]).some(e=>e.key.startsWith('eco:')));
});
test('pending obsolete price discarded; messages label source basis',()=>{
  const a=snapshot(0),b=snapshot(25,4500000),event=evaluate(b,[a]).find(e=>e.key.startsWith('main:'));
  assert.equal(stillRelevant(event,b),true);assert.equal(stillRelevant(event,snapshot(50)),false);
  assert.match(formatAlert({id:'vietjet',name:'Vietjet'},b,[event]),/24h; chưa xác định thuế/);
  assert.match(formatAlert({id:'vietjet',name:'Vietjet'},{...b,status:'error',source_pages:undefined},[]),/https:\/\/www.vietjetair.com/);
});
test('neighbor pair threshold and missing main price recovery',()=>{
  const a=snapshot(0),b=snapshot(25);
  a.cells.push({depart:'2027-02-06',return:'2027-02-14',price:4600000});
  b.cells.push({depart:'2027-02-06',return:'2027-02-14',price:4500000});
  assert.equal(evaluate(b,[a]).filter(e=>e.key.startsWith('pair:')).length,0);
  b.cells.at(-1).price=4599999;
  assert.equal(evaluate(b,[a]).filter(e=>e.key.startsWith('pair:')).length,0);
  assert.match(evaluate(snapshot(25),[{...a,main_price:null,status:'partial'}]).find(e=>e.key.startsWith('main:')).text,/có giá trở lại/);
});
test('persistent outbox, cooldown and retry_after; no credentials written',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fare-alert-test-'));
  const creds={token:'123:TEST_SECRET',chatId:'456',enabled:true,configured:true};let sent=0;
  const send=async()=>++sent;
  const call=(record,history,now,overrides={})=>notifyRecord({root,provider,record,history,settings,creds,send,now,...overrides});
  const a=snapshot(0),b=snapshot(25,4500000),c=snapshot(50,4500000);
  assert.equal((await call(a,[],0)).status,'sent');
  assert.equal((await call(b,[a],1500000,{send:async()=>{const e=new Error('secret');e.retryAfter=3600;throw e;}})).status,'send_failed');
  assert.equal((await call(c,[a,b],3000000)).status,'retry_wait');
  assert.equal((await call(snapshot(100,4500000),[a,b,c],6000000)).status,'sent');
  assert.equal((await call(snapshot(125,4500000),[a,b,c],7500000)).status,'unchanged');
  // Rebound then drop to the already notified price within cooldown stays silent.
  assert.equal((await call(snapshot(150,4500000),[a,b,snapshot(125)],9000000)).status,'unchanged');
  assert.equal(sent,2);
  assert.equal((await call(snapshot(175),[a,b],10500000,{creds:{...creds,chatId:'789'}})).status,'sent');
  const stored=await readFile(path.join(root,'data','notification-state.json'),'utf8');
  assert.ok(!stored.includes('TEST_SECRET'));assert.ok(!stored.includes('secret'));
});
test('failed discount is never retried after rebound',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fare-alert-test-')),creds={token:'123:TEST',chatId:'456',configured:true,enabled:true};
  const a=snapshot(0),b=snapshot(25,4500000);let sent=0;
  const args={root,provider,settings,creds};
  await notifyRecord({...args,record:a,history:[],now:0,send:async()=>1});
  await notifyRecord({...args,record:b,history:[a],now:1500000,send:async()=>{throw new Error();}});
  const result=await notifyRecord({...args,record:snapshot(50),history:[a,b],now:3000000,send:async()=>++sent});
  assert.equal(result.status,'unchanged');assert.equal(sent,0);
});
test('Telegram errors redact URL/token and expose retry_after only',async()=>{
  await assert.rejects(telegramCall('123:SECRET','sendMessage',{},async url=>{throw new Error(url);}),e=>!e.message.includes('SECRET')&&e.message.includes('TELEGRAM_NETWORK'));
  await assert.rejects(telegramCall('123:SECRET','sendMessage',{},async()=>({ok:false,status:429,json:async()=>({ok:false,error_code:429,parameters:{retry_after:90},description:'SECRET'})})),e=>e.retryAfter===90&&!e.message.includes('SECRET'));
});
