import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crawl,SOURCE} from '../src/providers/vna-agencies.mjs';
import {simulatedSources} from '../scripts/fixtures/agencies.mjs';
import {queryFrom} from '../src/providers/vna-core.mjs';
import {validateFeed} from '../src/worker/vna-feed.mjs';
import {crawl as readFeed,FEED_MAX_AGE_MS} from '../src/worker/vna-agencies.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import {formatCurrentPrices,formatProviderStatus} from '../src/monitoring/current-prices.mjs';
import {formatFlights} from '../src/monitoring/flights.mjs';
import app from '../src/worker/app.mjs';
import config from '../config.json' with {type:'json'};

const query=queryFrom(config);
const snapshot=async()=>crawl(query,{fetchImpl:simulatedSources(query).fetch});
const empty=(q,at)=>({agency:q.agency,leg:q.leg,date:q.date,status:'empty',flights:[],observed_at:at});
const error=q=>({agency:q.agency,leg:q.leg,date:q.date,status:'error'});

test('feed recomputes mixed and empty outcomes from fresh agency observations',async()=>{
  const original=await snapshot(),now=Date.now(),at=new Date(now-30000).toISOString();
  const mixed=structuredClone(original),index=mixed.agency_quotes.findIndex(q=>q.agency==='BestPrice');mixed.agency_quotes[index]={...empty(mixed.agency_quotes[index],at),Session:'secret'};
  mixed.status='error';mixed.main_price=1;
  const result=validateFeed(mixed,query,now);
  assert.equal(result.status,'ok');assert.equal(result.observed_at,at);assert.ok(result.main_price>1);
  assert.deepEqual(result.agency_quotes.find(q=>q.agency==='BestPrice'),empty(mixed.agency_quotes[index],at));
  const mixedProvider={id:'vna',name:'VNA',history:[result]};
  for(const text of [formatCurrentPrices({providers:[mixedProvider],query,now}),formatFlights({providers:[mixedProvider],query,now})]){
    assert.match(text,/BestPrice: không có báo giá phù hợp/);assert.doesNotMatch(text,/chưa lấy đủ giá|lượt cập nhật gần nhất thất bại/i);
  }
  assert.match(formatProviderStatus(mixedProvider,{now}),/không có báo giá phù hợp/);
  assert.doesNotMatch(JSON.stringify(result),/secret|Session/);
  const all=structuredClone(mixed);all.agency_quotes=all.agency_quotes.map(q=>empty(q,at));
  const clean=validateFeed(all,query,now);
  assert.equal(clean.status,'partial');assert.equal(clean.main_price,null);assert.equal(clean.minimum_price,null);
  assert.deepEqual(clean.legs.inbound,[{date:query.returnDate,price:null,flights:[]}]);assert.equal(clean.observed_at,at);
  all.agency_quotes=all.agency_quotes.map(q=>q.agency==='ABAY'?error(q):q);
  const partial=validateFeed(all,query,now);assert.equal(partial.status,'partial');assert.equal(partial.main_price,null);
  assert.ok(partial.leg_errors.inbound);
  const provider={id:'vna',name:'VNA',history:[partial]};
  for(const text of [formatCurrentPrices({providers:[provider],query,now}),formatFlights({providers:[provider],query,now})]){
    assert.match(text,/BestPrice: không có báo giá phù hợp/);assert.match(text,/ABAY: chưa cập nhật được/);
    assert.doesNotMatch(text,/hết vé|(?:^|\s)0đ/);
  }
  assert.match(formatProviderStatus(provider,{now}),/không có báo giá phù hợp.*chưa cập nhật được/);
});

test('feed rejects malformed, stale or contradictory empty outcomes and all-error feeds',async()=>{
  const record=await snapshot(),now=Date.now(),at=new Date(now).toISOString();
  record.agency_quotes=record.agency_quotes.map(q=>empty(q,at));
  for(const change of [q=>delete q.flights,q=>q.flights.push({}),q=>q.price=null,q=>q.base_fare=100,q=>q.fare_basis='Y',
    q=>q.observed_at='invalid',q=>q.observed_at=new Date(now-FEED_MAX_AGE_MS-1).toISOString(),q=>q.observed_at=new Date(now+60001).toISOString()]){
    const bad=structuredClone(record);change(bad.agency_quotes[0]);assert.throws(()=>validateFeed(bad,query,now));
  }
  record.agency_quotes=record.agency_quotes.map(error);assert.throws(()=>validateFeed(record,query,now));
});

test('endpoint and runtime replace current price with empty results without erasing minima',async t=>{
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());
  const store=new RuntimeStore(DB),jobs=[],env={DB,VNA_FEED_SECRET:'test-feed',JOBS:{async sendBatch(batch){jobs.push(...batch);}}};
  await store.putState('control',{active:true});
  const priced=await snapshot();await store.observeCurrent(validateFeed(priced,query));
  const key={basisSource:SOURCE,queryId:priced.query_id,kind:'inbound',departure:query.returnDate,back:''};
  const minimum=await store.minimum(key);assert.ok(minimum.price>0);
  const at=new Date(Date.now()).toISOString(),record=structuredClone(priced);
  record.observed_at=at;record.agency_quotes=record.agency_quotes.map(q=>empty(q,at));
  const response=await app.fetch(new Request('https://test/sources/vna',{method:'POST',headers:{'x-vna-feed-secret':'test-feed','content-type':'application/json'},body:JSON.stringify(record)}),env);
  assert.equal(response.status,202);assert.equal(jobs.length,1);
  const feed=await readFeed(query,{store,env:{VNA_FEED:'1'},fetchImpl:()=>assert.fail('unexpected network call')});
  await store.observeCurrent(feed);
  const current=await store.latest(SOURCE,priced.query_id);
  assert.equal(current.main_price,null);assert.equal(current.legs.inbound[0].price,null);assert.equal(current.last_attempt_failed,false);
  assert.equal((await store.minimum(key)).price,minimum.price);
  assert.equal((await store.statement('SELECT COUNT(*) AS n FROM price_minima WHERE price=0').first()).n,0);
  const provider={id:'vna',name:'VNA',history:[current],minimums:{inbound:minimum.price}};
  for(const text of [formatCurrentPrices({providers:[provider],query}),formatFlights({providers:[provider],query})]){
    assert.match(text,/BestPrice: không có báo giá phù hợp/);assert.match(text,/ABAY: không có báo giá phù hợp/);
    assert.doesNotMatch(text,/GIÁ CŨ|(?:^|\s)0đ/);
  }
  assert.match(formatProviderStatus(provider),/không có báo giá phù hợp/);
  await store.observeCurrent({...current,status:'error',observed_at:new Date(Date.now()+1000).toISOString(),error:'search failed'});
  const failed=await store.latest(SOURCE,priced.query_id);
  assert.equal(failed.main_price,null);assert.equal(failed.legs.inbound[0].price,null);assert.equal(failed.last_attempt_failed,true);
  assert.equal((await store.minimum(key)).price,minimum.price);
  assert.match(formatProviderStatus({...provider,history:[failed]}),/GIÁ CŨ.*thất bại/);
});

test('Flynow completed empty is distinct from a failed or stale search',()=>{
  const now=Date.now(),record={agency:'Flynow',status:'partial',observed_at:new Date(now).toISOString(),main_price:null,
    legs:{inbound:[{date:query.returnDate,price:null,flights:[]}]},leg_errors:{}};
  const provider={id:'vietjet',name:'Vietjet',history:[record]};
  for(const text of [formatCurrentPrices({providers:[provider],query,now}),formatFlights({providers:[provider],query,now})]){
    assert.match(text,/Flynow: không có báo giá phù hợp/);assert.doesNotMatch(text,/Flynow: chưa cập nhật được|GIÁ CŨ/);
  }
  assert.match(formatProviderStatus(provider,{now}),/không có báo giá phù hợp/);
  const failed={...record,leg_errors:{inbound:'search failed'}},failedProvider={...provider,history:[failed]};
  for(const text of [formatCurrentPrices({providers:[failedProvider],query,now}),formatFlights({providers:[failedProvider],query,now})]){
    assert.match(text,/Flynow: chưa cập nhật được/);assert.doesNotMatch(text,/Flynow: không có báo giá phù hợp/);
  }
  assert.doesNotMatch(formatProviderStatus(failedProvider,{now}),/không có báo giá phù hợp/);
  assert.match(formatProviderStatus(provider,{now:now+20*60000}),/GIÁ CŨ/);
});

test('roundtrip empty and failed legs remain distinct',async()=>{
  const roundtrip={...query,trackingMode:'roundtrip'},now=Date.now(),at=new Date(now).toISOString();
  const record=await crawl(roundtrip,{fetchImpl:simulatedSources(roundtrip).fetch});
  record.agency_quotes=record.agency_quotes.map(q=>q.leg==='inbound'?empty(q,at):error(q));
  const result=validateFeed(record,roundtrip,now);
  assert.equal(result.main_price,null);assert.equal(result.status,'partial');
  assert.ok(result.leg_errors.outbound);assert.equal(result.leg_errors.inbound,undefined);
  const provider={id:'vna',name:'VNA',history:[result]};
  for(const text of [formatCurrentPrices({providers:[provider],query:roundtrip,now}),formatFlights({providers:[provider],query:roundtrip,now})]){
    assert.match(text,/BestPrice: chưa cập nhật được/);assert.match(text,/ABAY: chưa cập nhật được/);
    assert.match(text,/BestPrice: không có báo giá phù hợp/);assert.match(text,/ABAY: không có báo giá phù hợp/);
  }
});
