import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crawl,SOURCE} from '../src/providers/vna-official.mjs';
import {queryFrom} from '../src/providers/vna-core.mjs';
import {validateFeed} from '../src/worker/vna-feed.mjs';
import {crawl as readFeed,feedKey,FEED_MAX_AGE_MS} from '../src/worker/vna-feed-source.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import app from '../src/worker/app.mjs';
import config from '../config.json' with {type:'json'};
const query=queryFrom(config);
const payload=entries=>({success:true,data:{prices:entries.map(([date,base,tax])=>({departureDate:date,price:[{base:String(base),totalTaxes:String(tax),total:String(base+tax),currencyCode:'VND'}]})),dictionaries:{currency:{VND:{decimalPlaces:0}}}}});
const snapshot=()=>crawl(query,{fetchImpl:async()=>Response.json(payload([[query.returnDate,4724000,1375181],['2027-02-11',1,1]]))});

test('official selected-day reference ignores cheaper neighboring days and never fabricates flight inventory',async()=>{
  const r=await snapshot();assert.equal(r.main_price,6099181);assert.equal(r.source,SOURCE);
  assert.equal(r.legs.inbound[0].base_fare+r.legs.inbound[0].airline_taxes,r.main_price);
  assert.equal(r.reference_only,true);assert.equal(r.flight_options_available,false);
  assert.deepEqual(r.legs.inbound[0].flights,[]);assert.equal(r.legs.inbound[0].flight_number,undefined);
  const empty=await crawl(query,{fetchImpl:async()=>Response.json(payload([]))});
  assert.equal(empty.main_price,null);assert.deepEqual(empty.leg_errors,{});
  await assert.rejects(crawl(query,{fetchImpl:async()=>new Response('',{status:403})}));
});

test('official feed reconstructs amounts and rejects stale, cross-query, foreign-currency and fabricated itinerary data',async()=>{
  const r=await snapshot(),now=Date.now();r.Session='PRIVATE';r.main_price=1;
  const clean=validateFeed(r,query,now);assert.equal(clean.main_price,6099181);assert.equal(clean.Session,undefined);
  for(const change of [x=>x.query.returnDate='2027-02-13',x=>x.currency='NOK',x=>x.source='vna-agency-estimates-v1',x=>x.legs.inbound[0].price--,x=>x.legs.inbound[0].flights.push({flight_number:'VN1640'}),x=>x.legs.inbound[0].observed_at=new Date(now-FEED_MAX_AGE_MS-1).toISOString(),x=>x.observed_at=new Date(now+60001).toISOString()]){
    const bad=structuredClone(r);change(bad);assert.throws(()=>validateFeed(bad,query,now));
  }
});

test('authenticated official feed deduplicates older writes, expires, and completed empty results preserve historical minima',async t=>{
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());
  const store=new RuntimeStore(DB);await store.putState('control',{active:false});
  const env={DB,VNA_FEED_SECRET:'expected'},r=await snapshot();
  const request=(record,secret='expected')=>new Request('https://test/sources/vna',{method:'POST',headers:{'content-type':'application/json','x-vna-feed-secret':secret},body:JSON.stringify(record)});
  assert.equal((await app.fetch(request(r,'wrong'),env)).status,401);
  assert.equal((await app.fetch(request(r),env)).status,202);
  assert.equal((await (await app.fetch(request(r),env)).json()).duplicate,true);
  const feed=await readFeed(query,{store,env:{VNA_FEED:'1'}});await store.observeCurrent(feed);
  const key={basisSource:SOURCE,queryId:r.query_id,kind:'inbound',departure:query.returnDate,back:''};
  assert.equal((await store.minimum(key)).price,6099181);
  const at=new Date(Date.parse(r.observed_at)+1000).toISOString(),empty=structuredClone(r);
  empty.observed_at=at;Object.assign(empty.legs.inbound[0],{price:null,base_fare:null,airline_taxes:null,observed_at:at});
  assert.equal((await app.fetch(request(empty),env)).status,202);
  assert.equal((await (await app.fetch(request(r),env)).json()).duplicate,true);
  const current=await readFeed(query,{store,env:{VNA_FEED:'1'}});await store.observeCurrent(current);
  assert.equal(current.main_price,null);assert.equal((await store.minimum(key)).price,6099181);
  assert.equal((await store.state(feedKey(query))).observed_at,at);
  const stale={state:store.state.bind(store),now:()=>Date.parse(at)+FEED_MAX_AGE_MS+1};
  await assert.rejects(readFeed(query,{store:stale,env:{VNA_FEED:'1'}}));
});
