import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crawl,adjustedQuote,parseBestprice,SOURCE} from '../src/providers/vna-agencies.mjs';
import {simulatedSources} from '../scripts/fixtures/agencies.mjs';
import {queryFrom,queryId} from '../src/providers/vna-core.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import config from '../config.json' with {type:'json'};
import {formatProviderStatus} from '../src/monitoring/current-prices.mjs';

const query=queryFrom(config),leg={leg:'inbound',from:'VCL',to:'SGN',date:'2027-02-13'};
const snapshot=async(options={})=>{const source=simulatedSources(query,options);return {record:await crawl(query,{fetchImpl:source.fetch}),source};};
test('status never reports an old last-good quote as healthy after a failure or feed expiry',()=>{
  const now=Date.parse('2026-10-22T07:40:00Z');
  const line=record=>formatProviderStatus({name:'Vietnam Airlines',history:record?[record]:[]},{now,pollMinutes:10});
  const recent={status:'ok',observed_at:new Date(now-60000).toISOString()};
  assert.match(line(recent),/ · ok$/);
  assert.match(line({...recent,last_attempt_failed:true}),/GIÁ CŨ.*thất bại/);
  assert.match(line({...recent,observed_at:'2026-10-22T03:46:00Z'}),/GIÁ CŨ.*chưa có cập nhật mới/);
  assert.match(line({...recent,status:'partial'}),/chưa đủ nguồn/);
  assert.match(line({...recent,status:'error'}),/GIÁ CŨ/);
  assert.match(line(null),/chưa có dữ liệu/);
});
test('both agencies are crawled, explicit fee is removed, and signed temporary offsets reproduce the reference fare',async()=>{
  const calibrated={...query,returnDate:leg.date},source=simulatedSources(calibrated,{inbound:5082181}),r=await crawl(calibrated,{fetchImpl:source.fetch});
  assert.equal(r.status,'ok');assert.equal(r.main_price,5082181);assert.equal(r.requests,8);assert.equal(source.requests.length,8);
  const ab=r.agency_quotes.find(q=>q.agency==='ABAY'),bp=r.agency_quotes.find(q=>q.agency==='BestPrice');
  assert.equal(bp.raw_price,5083000);assert.equal(bp.adjustment_vnd,-819);assert.equal(bp.ota_price-bp.agency_fee,bp.raw_price);
  assert.equal(ab.raw_price,5082000);assert.equal(ab.adjustment_vnd,181);assert.equal(ab.agency_fee,null);
  assert.equal(r.price_is_estimate,true);assert.notEqual(SOURCE,'vna-flynow-selected-flight-fares-v1');
  assert.doesNotMatch(JSON.stringify(r),/VIEWSTATE|vnisc_sid|FAKE|SelectValue|Session|Token/);
});
test('temporary calibration never spreads to another direction or date',()=>{
  assert.equal(adjustedQuote('bestprice',leg,{raw_price:5083000}).price,5082181);
  assert.equal(adjustedQuote('abay',leg,{raw_price:5082000}).price,5082181);
  for(const other of [{...leg,from:'SGN',to:'VCL'},{...leg,date:'2027-02-14'}])
    assert.equal(adjustedQuote('bestprice',other,{raw_price:5083000}).adjustment_vnd,0);
});
test('both agencies respect outbound, inbound and roundtrip tracking without adjacent dates',async()=>{
  for(const mode of ['outbound','inbound','roundtrip']){
    const q={...query,trackingMode:mode},source=simulatedSources(q),r=await crawl(q,{fetchImpl:source.fetch});
    assert.deepEqual(Object.keys(r.legs).sort(),mode==='roundtrip'?['inbound','outbound']:[mode]);
    assert.equal(r.agency_quotes.length,mode==='roundtrip'?4:2);assert.equal(r.requests,mode==='roundtrip'?16:8);
    assert.equal(r.main_price,mode==='roundtrip'?4200000:mode==='inbound'?2400000:1800000);
  }
});
test('one agency can fail independently; no quote is fabricated when both fail',async()=>{
  for(const failAgency of ['bestprice','abay']){const {record:r}=await snapshot({failAgency});assert.equal(r.status,'partial');assert.equal(r.main_price,2400000);assert.equal(r.agency_quotes.filter(q=>q.status==='ok').length,1);}
  let n=0;await assert.rejects(crawl(query,{fetchImpl:async()=>{n++;return Response.json({Session:'PRIVATE'},{status:503});}}),/BestPrice and ABAY/);assert.equal(n,2);
});
test('BestPrice rejects incompatible routes, discounts, bad amounts and sold-out fares',()=>{
  const fare={Airlines:'VN',From:'VCL',To:'SGN',Stop:0,FlightNumber:'VN-1469',DateFrom:'2027-02-13 17:50:00',DateTo:'2027-02-13 19:10:00',PriceInfo:[{Seat:8,Class:'J',ADT_Fare:4199000,ADT_Tax:884000,BP_Fee:100000,BP_Discount:0,BP_Discount_Total:0}]};
  const parse=f=>parseBestprice({search_data:{flight_data:[f]}},leg);
  for(const change of [f=>f.From='HAN',f=>f.PriceInfo[0].BP_Discount=1,f=>f.PriceInfo[0].BP_Fee=-1,f=>f.DateFrom='2027-02-14 17:50:00']){const f=structuredClone(fare);change(f);assert.throws(()=>parse(f));}
  const sold=structuredClone(fare);sold.PriceInfo[0].Seat=0;assert.deepEqual(parse(sold),[]);
});
test('BestPrice normalizes day-first dates without swapping months or accepting another itinerary day',()=>{
  const fare={Airlines:'VN',From:'VCL',To:'SGN',Stop:0,FlightNumber:'VN-1469',
    PriceInfo:[{Seat:8,Class:'J',ADT_Fare:4199000,ADT_Tax:884000,BP_Fee:100000,BP_Discount:0,BP_Discount_Total:0}]};
  const parse=(date,departure,arrival)=>parseBestprice({search_data:{flight_data:[{...fare,DateFrom:departure,DateTo:arrival}]}},{...leg,date});
  for(const date of ['2027-02-13','2027-05-06']){
    for(const wire of [date,date.split('-').reverse().join('-')]){
      const [quote]=parse(date,wire+' 17:50:00',wire+' 19:10:00');
      assert.equal(quote.departure,date+'T17:50:00');assert.equal(quote.arrival,date+'T19:10:00');
      assert.equal(quote.raw_price,5083000);
    }
  }
  for(const [departure,arrival] of [
    ['14-02-2027 17:50:00','14-02-2027 19:10:00'],
    ['13-02-2027 17:50:00','14-02-2027 19:10:00'],
    ['13-02-2027 17:50:00','13-02-2027 16:10:00'],
  ])assert.throws(()=>parse(leg.date,departure,arrival));
});
test('estimated minima never overwrite an earlier verified VNA minimum',async t=>{
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());const store=new RuntimeStore(DB),{record}=await snapshot();
  const verified={...record,source:'vna-flynow-selected-flight-fares-v1',query_id:'verified',price_is_estimate:false,main_price:100,
    legs:{inbound:[{date:query.returnDate,price:100}]}};
  await store.observeCurrent(verified);await store.observeCurrent(record);
  assert.equal((await store.minimum({basisSource:verified.source,queryId:'verified',kind:'inbound',departure:query.returnDate,back:''})).price,100);
  assert.equal((await store.minimum({basisSource:SOURCE,queryId:record.query_id,kind:'inbound',departure:query.returnDate,back:''})).price,2400000);
});
