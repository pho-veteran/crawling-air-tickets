import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {formatFlights} from '../src/monitoring/flights.mjs';
import {formatDaily} from '../src/monitoring/messages.mjs';
import {handleCommand,commandMenu,helpText,flightsReminder} from '../src/telegram/commands.mjs';
import {messageParts} from '../src/telegram/client.mjs';

const evidence=JSON.parse(await readFile(new URL('../docs/cloudflare-spike/selected-dates-evidence.json',import.meta.url)));
const probe=evidence.selected_sources_http.checks[0].result;
const query=probe.query,now=Date.parse(probe.observed_at)+5000;
const providers=probe.results.map(r=>({id:r.source,name:r.source==='vna'?'Vietnam Airlines':'Vietjet',history:[r.snapshot]}));
const settings={pollMinutes:10};
const update=(text,id=456,type='private')=>({message:{text,chat:{id,type}}});
function harness(){
  const sent=[],state={};let runs=0;
  return {sent,state,get runs(){return runs;},args:{root:'unused',state,creds:{chatId:'456'},username:'mine',now:()=>now,
    send:async(c,t)=>{sent.push({chat:c.chatId,text:t});return sent.length;},save:async()=>{},busy:async()=>false,
    context:async()=>({query,providers,settings}),quick:async()=>{runs++;return 0;},sleep:async()=>{},waitBudgetMs:0}};
}
test('recorded live prices list both dates and every offered flight/time for both airlines, with source and agency fees',()=>{
  const text=formatFlights({providers,query,now});
  assert.match(text,/04\/02\/2027/);assert.match(text,/13\/02\/2027/);assert.match(text,/UTC\+7/);
  assert.match(text,/VN1468.*15:50.*17:15.*5.102.181đ/);assert.match(text,/VN1469.*17:50.*19:10.*5.082.181đ/);
  for(const f of ['VJ370','VJ374','VJ376','VJ372','VJ371','VJ375','VJ377','VJ373'])assert.equal((text.match(new RegExp(f,'g'))||[]).length,1);
  assert.match(text,/phí đại lý 50.000đ/);assert.match(text,/Qua Flynow: 5.152.181đ/);
  assert.match(text,/chưa giữ chỗ/);assert.match(text,/Vietnam Airlines qua Flynow/);
  // The short price/daily view keeps a single selected flight, with no expanded schedule.
  const short=formatDaily({providers,query,now});assert.doesNotMatch(short,/VJ374|VJ372/);
});
test('duplicate fare families show the cheapest quote per actual flight; other times survive and neighboring dates do not leak',()=>{
  const p=structuredClone(providers[1]),date=p.history[0].legs.outbound[0],f=date.flights[0];
  date.flights.push({...f,price:f.price+100000,fare_family:'More expensive'},
    {...f,date:'2027-02-05',departure:'2027-02-05T10:00:00',flight_number:'VJ999'},
    {...f,flight_number:'VJ998',price:0});
  const text=formatFlights({providers:[p],query,now});
  assert.equal((text.match(/VJ370/g)||[]).length,1);assert.match(text,/VJ374/);
  assert.doesNotMatch(text,/More expensive|VJ999|VJ998|05\/02\/2027/);
});
test('missing/error/stale data is explicit, and large flight replies split without losing rows or cutting Unicode',()=>{
  const p=structuredClone(providers[1]);p.history.push({status:'error',observed_at:new Date(now-1000).toISOString()});
  assert.match(formatFlights({providers:[p],query,now}),/GIÁ CŨ/);
  const missing=structuredClone(providers[0]);missing.history[0].status='partial';missing.history[0].legs.inbound[0].flights=[];
  assert.match(formatFlights({providers:[missing],query,now}),/Chưa có danh sách chuyến có giá cho chiều này/);
  const noHistory={...p,history:[]};assert.match(formatFlights({providers:[noHistory],query,now}),/Chưa lấy được danh sách/);
  const text=formatFlights({providers,query,now}).repeat(4),parts=messageParts(text);
  assert.ok(parts.length>1);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=3500&&!/[\uD800-\uDBFF]$/.test(p)));
});
test('/flights refreshes both sources once, uses the caller, enforces authorization, and /price ends in a small reminder',async()=>{
  const h=harness();assert.equal((await handleCommand({...h.args,update:update('/flights',789)})).status,'ignored');
  assert.equal((await handleCommand({...h.args,update:update('/flights',456,'group')})).status,'ignored');
  assert.equal((await handleCommand({...h.args,update:update('/flights@other')})).status,'ignored');assert.equal(h.runs,0);
  const result=await handleCommand({...h.args,update:update('/flights@mine')});
  assert.equal(result.status,'flights');assert.equal(result.crawl_code,0);assert.equal(h.runs,1);
  assert.match(h.sent[1].text,/VJ374/);assert.ok(h.sent.every(m=>m.chat==='456'));
  assert.equal(h.state.lastFlightsAt,now);assert.equal(h.state.lastQuickAt,undefined);
  await handleCommand({...h.args,update:update('/price')});assert.equal(h.runs,2);
  assert.ok(h.sent.at(-1).text.endsWith(flightsReminder));assert.doesNotMatch(h.sent.at(-1).text,/VJ374/);
  await handleCommand({...h.args,update:update('/flights'),busy:async()=>true});assert.equal(h.runs,2);
  assert.match(h.sent.at(-1).text,/chạy khá lâu/);
  assert.ok(commandMenu.some(c=>c.command==='flights'));assert.match(helpText,/\/flights/);
});
