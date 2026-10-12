import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {handleCommand,commandMenu,helpText} from '../src/telegram/commands.mjs';
import {telegramCall} from '../src/telegram/client.mjs';
import {sendDaily} from '../src/monitoring/daily.mjs';
import {settingsFrom,evaluateAlerts,formatAlert,alertGroups,stillRelevant} from '../src/monitoring/alerts.mjs';
import {morningAt,nextMorning,formatDaily} from '../src/monitoring/messages.mjs';
import {createBatch} from '../src/shared/batch.mjs';
import {notifyRecord} from '../src/monitoring/notify.mjs';
const creds={token:'123:TEST_SECRET',chatId:'456',configured:true,enabled:true};
const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const settings=settingsFrom({},{}),record={query,status:'ok',source:'test',observed_at:'2026-10-12T00:00:00Z',main_price:5000000,minimum_price:3000000,cells:[{depart:'2027-02-05',return:'2027-02-15',price:3000000}],legs:{outbound:[{date:query.departureDate,price:2000000}],inbound:[{date:query.returnDate,price:3000000}]}};
const providers=[{id:'vna',name:'Vietnam Airlines',history:[record]},{id:'vietjet',name:'Vietjet',history:[record]}];
const temp=()=>mkdtemp(path.join(os.tmpdir(),'fare-command-test-'));
function harness(){const messages=[],documents=[],state={};let runs=0,saves=0,clock=Date.parse(record.observed_at);return {messages,documents,state,get runs(){return runs;},get saves(){return saves;},args:{root:'unused',creds,state,now:()=>clock,save:async()=>saves++,busy:async()=>false,sleep:async()=>{},waitBudgetMs:5000,context:async()=>({providers,query,settings}),report:async()=>'/report.html',send:async(c,t)=>{messages.push(t);return messages.length;},attach:async(c,f)=>{documents.push(f);return 1;},call:async()=>({is_bot:true}),quick:async()=>{runs++;clock+=1250;return 0;}}};}
const update=(text,id=456)=>({message:{text,chat:{id,type:'private'}}});
test('slash authorization, help, unknown and connection do not crawl',async()=>{
  const h=harness();assert.equal((await handleCommand({...h.args,update:update('/price',789)})).status,'ignored');
  assert.equal((await handleCommand({...h.args,update:update('/price@other'),username:'mine'})).status,'ignored');
  for(const cmd of ['/help','/start','/status','/connection','/oops'])await handleCommand({...h.args,update:update(cmd)});
  assert.equal(h.runs,0);assert.equal(h.messages.length,5);assert.match(h.messages[2],/07:00 UTC\+07:00/);
});
test('price always fetches fresh; busy waits for the lock, stuck lock falls back to cache',async()=>{
  const h=harness();const first=await handleCommand({...h.args,update:update('/price')});
  assert.equal(first.elapsed_ms,1250);assert.equal(h.runs,1);assert.equal(h.saves,1);assert.equal(h.documents.length,0);
  assert.match(h.messages[0],/Đang kiểm tra giá mới/);
  assert.match(h.messages[1],/VIETNAM AIRLINES/);assert.match(h.messages[1],/VIETJET/);assert.doesNotMatch(h.messages[1],/05\/02|15\/02|3.000.000đ.*Lân cận/);
  // Gọi liên tiếp vẫn lấy giá mới, không dùng cache theo cooldown 1 phút như trước.
  const second=await handleCommand({...h.args,update:update('/price')});
  assert.equal(second.elapsed_ms,1250);assert.equal(h.runs,2);assert.match(h.messages[3],/Giá vé bạn vừa hỏi đây/);
  // Lượt tự động đang chạy: chờ nhả lock rồi vẫn lấy giá mới.
  let polls=0;const freeing=async()=>++polls<=2;
  const third=await handleCommand({...h.args,update:update('/price'),busy:freeing});
  assert.equal(h.runs,3);assert.equal(third.crawl_code,0);
  assert.match(h.messages[4],/chờ xong rồi kiểm tra giá mới/);assert.match(h.messages[5],/Đang kiểm tra giá mới/);assert.match(h.messages[6],/Giá vé bạn vừa hỏi đây/);
  // Lượt nền kẹt quá lâu: mới dùng giá đã lưu và ghi rõ.
  await handleCommand({...h.args,update:update('/price'),busy:async()=>true,waitBudgetMs:0});
  assert.equal(h.runs,3);assert.match(h.messages.at(-1),/chạy khá lâu/);
  await handleCommand({...h.args,update:update('/report')});assert.equal(h.runs,3);
});
test('status shows polling, watcher, subscribers and config tech details',async()=>{
  const h=harness();
  await handleCommand({...h.args,update:update('/status')});
  const text=h.messages[0];
  assert.match(text,/Kết nối Telegram ổn rồi/);
  assert.match(text,/Bản tin tiếp theo/);
  assert.match(text,/Vòng lấy giá: mỗi 10 phút · tiếp theo ~/);
  assert.match(text,/Watcher: không thấy tiến trình/);
  assert.match(text,/Người đăng ký nhận tin: 1/);
  assert.match(text,/priceOnly tắt/);
  assert.match(text,/Lần \/price gần nhất: chưa có/);
  assert.match(text,/snapshot đã lưu/);
  const h2=harness();h2.state.lastQuickAt=h2.args.now();
  await handleCommand({...h2.args,update:update('/status'),busy:async()=>true});
  assert.match(h2.messages[0],/Vòng lấy giá: đang chạy/);
  assert.match(h2.messages[0],/Lần \/price gần nhất: 07:00 ngày 12\/10\/2026/);
});
test('partial quick result states incomplete instead of claiming complete',async()=>{
  const h=harness();await handleCommand({...h.args,update:update('/price'),quick:async()=>2});assert.match(h.messages[0],/Đang kiểm tra giá mới/);assert.match(h.messages[1],/chưa cập nhật đủ/);assert.doesNotMatch(h.messages[1],/Vừa kiểm tra xong/);
});
test('schedule is configured in env and obeys date boundary and offset',()=>{
  const s=settingsFrom({},{DAILY_REPORT_TIME:'23:15',DAILY_REPORT_UTC_OFFSET:'-03:30'}),at=Date.parse('2026-10-12T00:00:00Z');
  assert.equal(morningAt(at,s),Date.parse('2026-10-12T02:45:00Z'));assert.equal(nextMorning(at,s),morningAt(at,s));
  assert.throws(()=>settingsFrom({},{DAILY_REPORT_TIME:'25:00'}));assert.throws(()=>settingsFrom({},{DAILY_REPORT_UTC_OFFSET:'+14:30'}));
});
test('upgrade preserves acknowledged daily text and rebuilds unsent legacy content',async()=>{
  for(const acknowledged of [false,true]){
    const root=await temp(),now=Date.parse(record.observed_at);let sends=0;
    const args={root,providers,query,settings,creds,now};
    await sendDaily({...args,send:async()=>{throw new Error('network');}});
    const file=path.join(root,'data','daily-state.json'),db=JSON.parse(await readFile(file,'utf8'));
    const entry=Object.values(db.entries)[0];
    delete entry.messageVersion;entry.message='Legacy HTML /report';entry.reportFile='old.html';entry.nextAttemptAt=0;
    if(acknowledged)entry.messageId=99;
    await writeFile(file,JSON.stringify(db));
    const result=await sendDaily({...args,send:async(_,text)=>{sends++;assert.doesNotMatch(text,/HTML|\/report/);return 100;}});
    assert.equal(result.status,'sent');assert.equal(sends,acknowledged?0:1);
    const saved=Object.values(JSON.parse(await readFile(file,'utf8')).entries)[0];
    assert.equal(saved.reportFile,undefined);assert.equal(saved.messageId,acknowledged?99:100);
    assert.equal((await sendDaily({...args,send:async()=>{throw new Error('duplicate');}})).status,'already_sent');
  }
});
test('HTML command and upload are removed from the bot',async()=>{
  const h=harness();assert.equal((await handleCommand({...h.args,update:update('/report')})).status,'unknown');
  assert.equal(h.runs,0);assert.equal(h.documents.length,0);
  assert.ok(!commandMenu.some(c=>c.command==='report'));
  assert.doesNotMatch(helpText,/HTML|\/report/);
  await assert.rejects(telegramCall(creds.token,'sendDocument',{},async()=>{throw new Error('must not fetch');}),/không được hỗ trợ/);
});
test('retrieval has no pacing sleep, budget, or host cooldown',async()=>{
  const root=await temp();let clock=0;const opts={root,seconds:8,quick:true,now:()=>clock,sleep:async()=>{throw new Error('Must not sleep');},fetchImpl:async()=>{clock+=1000;return new Response('{}');}};
  const b=await createBatch(opts);for(let i=0;i<5;i++)await b.fetch('https://example.test');assert.equal((await b.finish()).requests,5);assert.equal(b.requests,5);
  const failed=await createBatch({...opts,fetchImpl:async()=>new Response('',{status:429})});await failed.fetch('https://example.test');const retry=await createBatch(opts);await retry.fetch('https://example.test');assert.equal(retry.requests,1);
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
