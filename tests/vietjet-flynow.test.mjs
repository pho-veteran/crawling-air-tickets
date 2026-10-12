import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {crawl,normalizeSearch,requestFrom,SOURCE} from '../src/providers/vietjet.mjs';
import {queryFrom,queryId} from '../src/providers/vna.mjs';
import {readHistory} from '../src/reporting/history.mjs';
import {fare,simulatedFlynow} from '../scripts/fixtures/flynow.mjs';
const q=queryFrom({origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1});
const parse=data=>normalizeSearch({Status:true,ListFareData:data},q,q.departureDate,q.returnDate);
test('live sanitized SkyBoss fixture reproduces official total, agency fees excluded',async()=>{
  const payload=JSON.parse(await readFile(new URL('../scripts/fixtures/flynow-skyboss.json',import.meta.url)));
  const quotes=normalizeSearch(payload,q,q.departureDate,q.returnDate);
  assert.equal(Math.min(...quotes.outbound.map(x=>x.price))+Math.min(...quotes.inbound.map(x=>x.price)),9761562);
  assert.equal(quotes.outbound[0].ota_price,4940781);
  assert.equal(quotes.outbound[0].agency_fee,50000);
  assert.equal(quotes.inbound[0].airline_taxes,880781);
  assert.doesNotMatch(JSON.stringify(quotes),/Session|Token|FlightValue/);
});
test('fee is read from each quote, not hardcoded or removed twice',()=>{
  for(const fee of [0,10000,50000,125000]){
    const f=fare(0,q,q.departureDate,4890781,{fee,base:3990000});
    const x=parse([f]).outbound[0];assert.equal(x.price,4890781);assert.equal(x.ota_price-x.price,fee);
  }
});
test('bad totals, currency, passengers, dates, discounts and mixed itineraries fail closed',()=>{
  const cases=[f=>f.TotalPrice++,f=>delete f.TotalServiceFee,f=>f.Currency='USD',f=>f.Adt=2,
    f=>f.TotalAgentDiscount=10000,f=>f.TotalAirlineDiscount=10000,
    f=>f.ListOption[0].ListFlight[0].StartDate='2027-02-05T06:00:00',
    f=>f.ListOption[0].ListFlight.push(structuredClone(f.ListOption[0].ListFlight[0]))];
  for(const change of cases){const f=fare(0,q,q.departureDate);change(f);assert.throws(()=>parse([f]));}
});
test('sold-out cheap fare cannot undercut an available fare',()=>{
  const cheap=fare(0,q,q.departureDate,1800000);cheap.ListOption[0].ListFlight[0].ListSegment[0].SeatAvl=0;
  assert.deepEqual(parse([cheap]).outbound,[]);
  const good=fare(0,q,q.departureDate,4890781);assert.equal(parse([cheap,good]).outbound[0].price,4890781);
});
test('seven searches build 49 distinct date pairs from flight prices, never teaser prices',async()=>{
  const source=simulatedFlynow(q);const r=await crawl(q,{fetchImpl:source.fetch});
  assert.equal(source.requests.length,7);assert.equal(r.status,'ok');assert.equal(r.cells.length,49);
  assert.equal(r.main_price,4200000);assert.equal(r.cells[0].price,4140000);assert.equal(r.taxes_included,true);
  assert.equal(requestFrom(q).get('system'),'EVJ');
  assert.deepEqual(JSON.parse(requestFrom(q).get('listFlight')).map(x=>x.DepartDate),['04022027','13022027']);
});
test('partial failure leaves unknown cells; HTTP 403/429 stops scheduling further dates',async()=>{
  const source=simulatedFlynow(q);let calls=0;
  const r=await crawl(q,{fetchImpl:async(...args)=>{calls++;return calls===1?new Response('',{status:503}):source.fetch(...args);}});
  assert.equal(r.status,'partial');assert.equal(r.main_price,null);assert.equal(r.cells.filter(c=>c.price!==null).length,36);
  for(const status of [403,429]){let attempts=0;await assert.rejects(crawl(q,{fetchImpl:async()=>{attempts++;return new Response('',{status});}}));assert.ok(attempts<=2);}
});
test('old untaxed calendar history is isolated by the new source identity',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'flynow-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=simulatedFlynow(q),record=await crawl(q,{fetchImpl:source.fetch});
  const oldSource='vietjet-public-calendar-v1',old={...record,source:oldSource,query_id:queryId(q,oldSource),main_price:5660000};
  const file=path.join(dir,'history.jsonl');await writeFile(file,[old,record].map(x=>JSON.stringify(x)).join('\n'));
  assert.deepEqual((await readHistory(file,q,SOURCE)).map(x=>x.main_price),[4200000]);
});
