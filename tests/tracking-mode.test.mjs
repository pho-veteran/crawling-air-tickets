import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryFrom,queryId} from '../src/providers/vna-core.mjs';
import * as vna from '../src/providers/vna-flynow.mjs';
import * as vietjet from '../src/providers/vietjet-flynow.mjs';
import {simulatedFlynow} from '../scripts/fixtures/flynow.mjs';
import {trackingMode,trackedRecord} from '../src/shared/tracking.mjs';
import {formatCurrentPrices} from '../src/monitoring/current-prices.mjs';
import {formatFlights} from '../src/monitoring/flights.mjs';
import {bookingLinks} from '../src/monitoring/booking-links.mjs';
import {evaluateAlerts,stillRelevant,defaults,formatAlert} from '../src/monitoring/alerts.mjs';
import {observationModel} from '../src/storage/d1.mjs';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
const config={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const q=mode=>queryFrom({...config,monitoring:{trackingMode:mode}});

test('tracking flag defaults to roundtrip, rejects typos and preserves existing fare dimension identity',()=>{
  assert.equal(trackingMode(queryFrom(config)),'roundtrip');
  assert.throws(()=>q('return'),/trackingMode/);
  for(const provider of [vna,vietjet])for(const mode of ['inbound','outbound'])assert.equal(queryId(q(mode),provider.SOURCE),queryId(q('roundtrip'),provider.SOURCE));
});
for(const provider of [vna,vietjet])for(const mode of ['roundtrip','outbound','inbound'])test(provider.SOURCE+' '+mode+' searches only selected routes/dates and keeps wire Leg separate from itinerary direction',async()=>{
  const query=q(mode),source=simulatedFlynow(query);let wire;
  const r=await provider.crawl(query,{fetchImpl:async(url,options)=>{wire=JSON.parse(options.body.get('listFlight'));return source.fetch(url,options);}});
  assert.deepEqual(wire.map(x=>[x.Leg,x.StartPoint,x.EndPoint,x.DepartDate]),mode==='roundtrip'?[[0,'SGN','VCL','04022027'],[1,'VCL','SGN','13022027']]:
    mode==='inbound'?[[0,'VCL','SGN','13022027']]:[[0,'SGN','VCL','04022027']]);
  assert.equal(source.requests.length,1);assert.equal(r.status,'ok');
  assert.equal(r.main_price,mode==='roundtrip'?4200000:mode==='inbound'?2400000:1800000);
  assert.deepEqual(Object.keys(r.legs),mode==='roundtrip'?['outbound','inbound']:[mode]);
  assert.deepEqual(observationModel(r).quotes.map(x=>x.kind).sort(),mode==='roundtrip'?['inbound','outbound','roundtrip']:[mode]);
  const p={id:provider===vna?'vna':'vietjet',name:'Airline',history:[r]},args={providers:[p],query,now:Date.parse(r.observed_at),onDemand:true};
  const price=formatCurrentPrices(args),flights=formatFlights(args);
  if(mode!=='roundtrip'){
    assert.doesNotMatch(price,/Tổng hai chiều|tổng |⇄/);
    assert.match(price,mode==='inbound'?/VCL → SGN/:/SGN → VCL/);
    assert.doesNotMatch(price+'\n'+flights,mode==='inbound'?/04\/02\/2027|VN1468|VJ370|04022027|2027-02-04/:/13\/02\/2027|VN1469|VJ371|13022027|2027-02-13/);
    for(const link of bookingLinks(p.id,query,r))assert.doesNotMatch(link.url,/returnDate|tripType=roundTrip/);
  }
});

test('switching to inbound preserves its previous minimum and never replaces the roundtrip minimum with one-way fare',async t=>{
  const DB=new LocalD1();await DB.migrate();t.after(()=>DB.close());const store=new RuntimeStore(DB);
  const total=await vna.crawl(q('roundtrip'),{fetchImpl:simulatedFlynow(q('roundtrip')).fetch});await store.observeCurrent(total);
  const back=await vna.crawl(q('inbound'),{fetchImpl:simulatedFlynow(q('inbound'),{inbound:2500000}).fetch});await store.observeCurrent(back);
  const prefix={basisSource:vna.SOURCE,queryId:back.query_id};
  assert.equal((await store.minimum({...prefix,kind:'inbound',departure:config.returnDate})).price,2400000);
  assert.equal((await store.minimum({...prefix,kind:'roundtrip',departure:config.departureDate,back:config.returnDate})).price,4200000);
  await store.observeCurrent({...back,status:'error',main_price:null,legs:{},observed_at:new Date(Date.parse(back.observed_at)+1000).toISOString()});
  const current=await store.latest(vna.SOURCE,back.query_id);assert.equal(current.main_price,2500000);assert.equal(current.last_attempt_failed,true);
  assert.deepEqual(Object.keys(current.legs),['inbound']);
});

test('inbound monitoring ignores outbound/total drops and discards queued alerts for excluded dimensions',async()=>{
  const old=await vna.crawl(q('roundtrip'),{fetchImpl:simulatedFlynow(q('roundtrip')).fetch});
  old.observed_at='2026-10-12T00:00:00Z';
  const make=price=>({...old,query:q('inbound'),observed_at:'2026-10-13T00:00:00Z',main_price:price+1,
    legs:{outbound:[{date:config.departureDate,price:1}],inbound:[{date:config.returnDate,price}]}});
  assert.equal(evaluateAlerts({id:'vna'},make(2400000),[old],{initialized:true},defaults).length,0);
  const events=evaluateAlerts({id:'vna'},make(2300000),[old],{initialized:true},defaults);
  assert.ok(events.length>0);assert.ok(events.every(e=>e.guard.kind==='leg'&&e.guard.leg==='inbound'));
  const text=formatAlert({id:'vna',name:'VNA'},make(2300000),events,[old]);assert.match(text,/Vé về VCL → SGN/);assert.doesNotMatch(text,/Tổng hai chiều|04\/02|VN1468/);
  assert.equal(stillRelevant({guard:{kind:'main',price:2300001}},make(2300000)),false);
  assert.equal(stillRelevant({guard:{kind:'leg',leg:'outbound',date:config.departureDate,source:vna.SOURCE,price:1}},make(2300000)),false);
  assert.equal(trackedRecord(old,q('inbound')).main_price,2400000);
});
