import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {formatDaily,nextMorning,morningAt,messageEntities,change} from '../lib/messages.mjs';
import {sendDaily} from '../lib/daily.mjs';
import {settingsFrom} from '../lib/alerts.mjs';
import {smokeCases} from '../lib/smoke-cases.mjs';
const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const at=s=>Date.parse(s),today=at('2026-10-12T07:00:00+07:00'),settings=settingsFrom();
const record=(observed_at,main_price)=>({observed_at,status:'ok',main_price,minimum_price:3000000,cells:[{depart:'2027-02-05',return:'2027-02-15',price:3000000}],legs:{outbound:[{date:query.departureDate,price:2000000}],inbound:[{date:query.returnDate,price:2500000}]}});
const providers=[{id:'vna',name:'Vietnam Airlines',history:[record('2026-10-11T22:50:00+07:00',6000000),record('2026-10-12T06:50:00+07:00',5000000)]},{id:'vietjet',name:'Vietjet',history:[record('2026-10-11T22:50:00+07:00',4000000),record('2026-10-12T06:50:00+07:00',4500000)]}];
const creds={token:'123:TEST_SECRET',chatId:'456',enabled:true,configured:true};
test('07:00 is Vietnam time, independent of host and 25-minute poll phase',()=>{
  assert.equal(nextMorning(at('2026-10-11T23:59:59Z')),today);
  assert.equal(nextMorning(today),today+86400000);
  assert.equal(morningAt(at('2026-10-12T06:59:00+07:00')),today);
});
test('daily combines both airlines with independent upward/downward/unchanged deltas',()=>{
  const text=formatDaily({providers,query,now:today});
  assert.match(text,/VIETNAM AIRLINES/);assert.match(text,/VIETJET/);assert.match(text,/↓ 1.000.000đ/);assert.match(text,/↑ 500.000đ/);assert.match(text,/↔ Không đổi/);
  assert.match(text,/trước hôm nay/);assert.doesNotMatch(text,/GIÁ CŨ/);assert.match(text,/thuế\/phí khác nhau/);
  assert.equal(change(null,5000),'chưa có mốc so sánh');
});
test('stale and missing data are never presented as fresh prices',()=>{
  const text=formatDaily({providers:[{...providers[0],history:[providers[0].history[0],{observed_at:'2026-10-12T06:50:00+07:00',status:'error'}]},{...providers[1],history:[]}],query,now:today});
  assert.match(text,/GIÁ CŨ/);assert.match(text,/Chưa lấy được giá của hãng này/);assert.doesNotMatch(text,/Khứ hồi: 0đ/);
});
test('daily dedupe persists across calls/restarts, recipients and dates are isolated',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fare-daily-test-'));let count=0;const args={root,providers,query,settings,creds,attach:async()=>77,report:async()=>'fake.html',send:async()=>++count};
  assert.equal((await sendDaily({...args,now:today-1})).status,'not_due');
  assert.equal((await sendDaily({...args,now:today})).status,'sent');
  assert.equal((await sendDaily({...args,now:today+300000})).status,'already_sent');
  assert.equal((await sendDaily({...args,now:today,creds:{...creds,chatId:'789'}})).status,'sent');
  assert.equal((await sendDaily({...args,now:today+86400000})).status,'sent');assert.equal(count,3);
  assert.ok(!(await readFile(path.join(root,'data','daily-state.json'),'utf8')).includes('TEST_SECRET'));
});
test('daily retry_after is respected and failure never marks the day delivered',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fare-daily-test-')),args={root,providers,query,settings,creds,attach:async()=>77,report:async()=>'fake.html'};let count=0;
  assert.equal((await sendDaily({...args,now:today,send:async()=>{const e=new Error();e.retryAfter=3600;throw e;}})).status,'send_failed');
  const send=async()=>++count;
  assert.equal((await sendDaily({...args,now:today+300000,send})).status,'retry_wait');assert.equal(count,0);
  assert.equal((await sendDaily({...args,now:today+3600000,send})).status,'sent');assert.equal(count,1);
});
test('daily lock prevents two schedulers sending the same digest concurrently',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fare-daily-test-'));let release,started;
  const ready=new Promise(r=>started=r),waiting=new Promise(r=>release=r),args={root,providers,query,settings,creds,attach:async()=>77,report:async()=>'fake.html',now:today};
  const one=sendDaily({...args,send:async()=>{started();await waiting;return 1;}});await ready;
  assert.equal((await sendDaily({...args,send:async()=>2})).status,'busy');release();assert.equal((await one).status,'sent');
});
test('bold entities use valid UTF-16 spans, remain disjoint and preserve literal markup',()=>{
  const text='🛫 Săn vé <tag> & thử\n🟦 VIETNAM AIRLINES\nGiá: 2.500.000đ · ↓ 500.000đ (16.7%)';
  const entities=messageEntities(text);assert.ok(entities.length>=4);
  assert.equal(text.slice(entities[0].offset,entities[0].offset+entities[0].length),'🛫 Săn vé <tag> & thử');
  for(let i=1;i<entities.length;i++)assert.ok(entities[i].offset>=entities[i-1].offset+entities[i-1].length);
  assert.ok(entities.some(e=>text.slice(e.offset,e.offset+e.length)==='2.500.000đ'));
});
test('smoke covers every message family and labels all data as simulated',()=>{
  const cases=smokeCases(today),keys=cases.flatMap(c=>c.keys);
  for(const prefix of ['baseline','main:','leg:','eco:','error','recovery','daily','daily-stale','multipart'])assert.ok(keys.some(k=>k.startsWith(prefix)),prefix);
  assert.ok(cases.every(c=>c.text.includes('SMOKE TEST')&&c.text.includes('DỮ LIỆU MÔ PHỎNG')));
  assert.match(cases.find(c=>c.name.startsWith('Đáy 7')).text,/Thấp nhất trong 7/);
});
