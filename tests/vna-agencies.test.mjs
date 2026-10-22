import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crawl,adjustedQuote,parseBestprice,SOURCE} from '../src/providers/vna-agencies.mjs';
import {simulatedSources} from '../scripts/fixtures/agencies.mjs';
import {queryFrom,queryId} from '../src/providers/vna-core.mjs';
import {validateFeed} from '../src/worker/vna-feed.mjs';
import {crawl as readFeed,feedKey,FEED_MAX_AGE_MS} from '../src/worker/vna-agencies.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import config from '../config.json' with {type:'json'};
import app from '../src/worker/app.mjs';
import {formatCurrentPrices} from '../src/monitoring/current-prices.mjs';
import {formatFlights} from '../src/monitoring/flights.mjs';

const query=queryFrom(config),leg={leg:'inbound',from:'VCL',to:'SGN',date:'2027-02-13'};
const snapshot=async(options={})=>{const source=simulatedSources(query,options);return {record:await crawl(query,{fetchImpl:source.fetch}),source};};
test('both agencies are crawled, explicit fee is removed, and signed temporary offsets reproduce the reference fare',async()=>{
  const source=simulatedSources(query,{inbound:5082181}),r=await crawl(query,{fetchImpl:source.fetch});
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
test('price and flights replies show both raw agency prices, correction signs and estimate labels',async()=>{
  const {record}=await snapshot({inbound:5082181}),p={id:'vna',name:'Vietnam Airlines',history:[record]};
  for(const text of [formatCurrentPrices({providers:[p],query}),formatFlights({providers:[p],query})]){
    assert.match(text,/BestPrice: 5\.083\.000đ −819đ → 5\.082\.181đ/);assert.match(text,/ABAY: 5\.082\.000đ \+181đ → 5\.082\.181đ/);
    assert.match(text,/ước tính/);assert.doesNotMatch(text,/Qua Flynow/);
  }
});
test('feed validation recomputes amounts, rejects wrong itinerary/age, and strips supplier secrets',async()=>{
  const {record}=await snapshot();record.Session='PRIVATE';record.agency_quotes[0].flights[0].Token='PRIVATE';
  const clean=validateFeed(record,query);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE|Session|Token/);
  for(const change of [r=>r.query.trackingMode='outbound',r=>r.observed_at='2026-01-01T00:00:00Z',r=>r.agency_quotes.pop(),
    r=>r.agency_quotes[0].flights[0].price--,r=>r.agency_quotes[0].flights[0].raw_price--,
    r=>r.agency_quotes[0].flights[0].observed_at=new Date(Date.now()+120000).toISOString(),r=>r.agency_quotes[0].flights[0].departure='2027-02-14T06:00:00']){
    const bad=structuredClone(record);change(bad);assert.throws(()=>validateFeed(bad,query));
  }
});
test('feed endpoint authenticates, deduplicates, rejects older writes and triggers a shared refresh',async t=>{
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());const store=new RuntimeStore(DB);await store.putState('control',{active:true});
  const jobs=[],env={DB,VNA_FEED_SECRET:'test-feed',JOBS:{async sendBatch(batch){jobs.push(...batch);}}};
  const {record}=await snapshot();const req=(r=record,secret='test-feed')=>new Request('https://test/sources/vna',{method:'POST',headers:{'x-vna-feed-secret':secret,'content-type':'application/json'},body:JSON.stringify(r)});
  assert.equal((await app.fetch(req(record,'wrong'),env)).status,401);assert.equal(jobs.length,0);
  assert.equal((await app.fetch(req(),env)).status,202);assert.equal(jobs.length,1);
  assert.equal((await (await app.fetch(req(),env)).json()).duplicate,true);assert.equal(jobs.length,1);
  const later=structuredClone(record);for(const q of later.agency_quotes)for(const f of q.flights)f.observed_at=new Date(Date.parse(f.observed_at)+1000).toISOString();later.observed_at=new Date(Date.parse(later.observed_at)+1000).toISOString();
  assert.equal((await app.fetch(req(later),env)).status,202);
  assert.equal((await (await app.fetch(req(),env)).json()).duplicate,true);
  const saved=await store.state(feedKey(query));assert.equal(saved.observed_at,later.observed_at);
  const fromFeed=await readFeed(query,{store,env:{VNA_FEED:'1'},fetchImpl:()=>assert.fail('must not call agencies from Worker')});assert.equal(fromFeed.main_price,record.main_price);
  const staleStore={...store,now:()=>Date.parse(saved.observed_at)+FEED_MAX_AGE_MS+1,state:store.state.bind(store)};
  await assert.rejects(readFeed(query,{store:staleStore,env:{VNA_FEED:'1'}}),/older than 15 minutes/);
  assert.equal((await store.statement('SELECT COUNT(*) AS n FROM price_quotes').first()).n,0);
});
test('estimated minima never overwrite an earlier verified VNA minimum',async t=>{
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());const store=new RuntimeStore(DB),{record}=await snapshot();
  const verified={...record,source:'vna-flynow-selected-flight-fares-v1',query_id:'verified',price_is_estimate:false,main_price:100,
    legs:{inbound:[{date:query.returnDate,price:100}]}};
  await store.observeCurrent(verified);await store.observeCurrent(record);
  assert.equal((await store.minimum({basisSource:verified.source,queryId:'verified',kind:'inbound',departure:query.returnDate,back:''})).price,100);
  assert.equal((await store.minimum({basisSource:SOURCE,queryId:record.query_id,kind:'inbound',departure:query.returnDate,back:''})).price,2400000);
});
