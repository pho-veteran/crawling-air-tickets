import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {evaluateAlerts,settingsFrom,stillRelevant,formatAlert} from '../lib/alerts.mjs';
import {notifyRecord} from '../lib/notify.mjs';
import {messageParts,sendTelegram} from '../lib/telegram.mjs';
const provider={id:'vna',name:'Vietnam Airlines',source:'vna-fare-matrix-v1'},settings=settingsFrom();
const q={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const record=(at,out=3000000,back=4000000)=>({source:provider.source,legs_source:'vna-air-best-price-oneway-v1',query_id:'test-legs',query:q,status:'ok',observed_at:at,main_price:6500000,minimum_price:6500000,
  cells:[{depart:q.departureDate,return:q.returnDate,price:6500000}],legs:{outbound:[{date:q.departureDate,price:out}],inbound:[{date:q.returnDate,price:back}]}});
const check=(r,h)=>evaluateAlerts(provider,r,h,{initialized:true},settings);
test('outbound decrease alerts when roundtrip is unchanged and inbound rises; inbound too is independent',()=>{
  const a=record('2026-10-11T00:00:00Z'),b=record('2026-10-11T00:25:00Z',2999999,4000001);
  const events=check(b,[a]),legs=events.filter(e=>e.guard.kind==='leg');
  assert.equal(legs.length,1);assert.equal(legs[0].guard.leg,'outbound');assert.match(legs[0].text,/giảm 1đ.*chưa từng thấy/);
  assert.equal(events.some(e=>e.key.startsWith('main:')),false);
  assert.match(formatAlert(provider,b,events),/Vé đi SGN → VCL 04\/02\/2027/);
  const c=record('2026-10-11T00:50:00Z',3100000,3500000);
  assert.equal(check(c,[a,b]).filter(e=>e.guard.kind==='leg')[0].guard.leg,'inbound');
});
test('first, missing and changed-source quotes are never invented lows; compare last valid same leg/date',()=>{
  const a=record('2026-10-11T00:00:00Z'),b=record('2026-10-11T00:25:00Z',null),c=record('2026-10-11T00:50:00Z',2900000);
  assert.equal(check(a,[]).length,0);assert.equal(check(b,[a]).length,0);
  assert.equal(check(c,[a,b]).filter(e=>e.guard.kind==='leg').length,1);
  assert.equal(check({...c,legs_source:'new-source'},[a,b]).length,0);
  const noLegs={...a};delete noLegs.legs;assert.equal(check(c,[noLegs]).length,0);
});
test('rolling low is per date and leg; neighbors use threshold or strict low',()=>{
  const old=record('2026-09-01T00:00:00Z',2500000),a=record('2026-10-11T00:00:00Z'),b=record('2026-10-11T00:25:00Z',2900000);
  const event=check(b,[old,a]).find(e=>e.guard.kind==='leg');assert.match(event.text,/giá tốt nhất.*7 ngày/);assert.doesNotMatch(event.text,/đáy mới toàn/);
  old.legs.outbound.push({date:'2027-02-05',price:2000000});a.legs.outbound.push({date:'2027-02-05',price:2500000});b.legs.outbound.push({date:'2027-02-05',price:2499999});
  const recentLow={...old,observed_at:'2026-10-10T00:00:00Z'};
  assert.equal(check(b,[recentLow,a]).some(e=>e.guard.date==='2027-02-05'),false);
  b.legs.outbound[1].price=2300000;assert.equal(check(b,[recentLow,a]).some(e=>e.guard.date==='2027-02-05'),false);
});
test('pending leg is invalidated by rebound, missing or different source, not by the other leg',()=>{
  const a=record('2026-10-11T00:00:00Z'),b=record('2026-10-11T00:25:00Z',2900000),e=check(b,[a]).find(e=>e.guard.kind==='leg');
  assert.equal(stillRelevant(e,b),true);assert.equal(stillRelevant(e,{...b,legs_source:'other'}),false);
  assert.equal(stillRelevant(e,record('2026-10-11T00:50:00Z',2900000,5000000)),true);
  assert.equal(stillRelevant(e,record('2026-10-11T00:50:00Z',3000000)),false);
  assert.equal(stillRelevant(e,record('2026-10-11T00:50:00Z',null)),false);
});
test('persistent dedupe distinguishes directions and lower prices when roundtrip never moves',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fare-leg-test-')),creds={token:'123:TEST',chatId:'456',enabled:true,configured:true};let count=0;
  const send=async()=>++count,call=(r,h,now)=>notifyRecord({root,provider,record:r,history:h,settings,creds,send,now});
  const a=record('2026-10-11T00:00:00Z'),b=record('2026-10-11T00:25:00Z',2900000),c=record('2026-10-11T00:50:00Z',2900000),d=record('2026-10-11T01:15:00Z',2900000,2900000),e=record('2026-10-11T01:40:00Z',2800000,2900000);
  await call(a,[],0);assert.equal((await call(b,[a],1500000)).status,'sent');assert.equal((await call(c,[a,b],3000000)).status,'unchanged');
  assert.equal((await call(d,[a,b,c],4500000)).status,'sent');assert.equal((await call(e,[a,b,c,d],6000000)).status,'sent');assert.equal(count,4);
  const rebound=record('2026-10-11T02:05:00Z',3000000,2900000),same=record('2026-10-11T02:30:00Z',2800000,2900000);
  assert.equal((await call(same,[a,b,c,d,e,rebound],9000000)).status,'unchanged');
});
test('long alerts are split without losing any event or cutting Unicode',async()=>{
  const text=('✈️ Vé đi giảm giá\n').repeat(600),parts=messageParts(text);
  assert.equal(parts.join(''),text);assert.ok(parts.length>1);assert.ok(parts.every(p=>p.length<=3501&&!/[\uD800-\uDBFF]$/.test(p)));
  const sent=[];const id=await sendTelegram({token:'123:TEST',chatId:'456',enabled:true,configured:true},text,async(url,options)=>{
    sent.push(JSON.parse(options.body).text);return {ok:true,json:async()=>({ok:true,result:{message_id:sent.length}})};
  });assert.equal(sent.join(''),text);assert.equal(id,sent.length);
});
