import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {crawl,SOURCE,normalizeSearch} from '../src/providers/vna-flynow.mjs';
import {queryFrom} from '../src/providers/vna-core.mjs';
import {formatDaily} from '../src/monitoring/messages.mjs';
import {formatAlert} from '../src/monitoring/alerts.mjs';
import {fingerprint,diagnose} from '../src/worker/vna-diagnostic.mjs';

const query=queryFrom({origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1});
const sample=JSON.parse(await readFile(new URL('../scripts/fixtures/flynow-vna-selected.json',import.meta.url)));
const official=JSON.parse(await readFile(new URL('../docs/cloudflare-spike/vna-web/official-comparison.json',import.meta.url)));
test('recorded VNA agency fares retain verified taxes, fees, flight times and a separate source/basis',async()=>{
  let attempts=0;
  const snapshot=await crawl(query,{fetchImpl:async(url,opts)=>{
    attempts++;assert.equal(opts.body.get('system'),'EVN');
    assert.deepEqual(JSON.parse(opts.body.get('listFlight')).map(f=>f.DepartDate),['04022027','13022027']);
    return Response.json(sample);
  }});
  assert.equal(attempts,1);assert.equal(query.nearbyDays,0);assert.equal(snapshot.cells.length,1);
  assert.equal(snapshot.source,SOURCE);assert.notEqual(SOURCE,'vna-fare-matrix-v1');
  assert.equal(snapshot.main_price,10184362);assert.match(snapshot.price_basis,/sum-of-oneway/);
  const out=snapshot.legs.outbound[0],back=snapshot.legs.inbound[0];
  assert.equal(out.flight_number,'VN1468');assert.equal(out.departure,'2027-02-04T15:50:00');
  assert.equal(back.flight_number,'VN1469');assert.equal(back.arrival,'2027-02-13T19:10:00');
  assert.equal(out.price,5102181);assert.equal(out.airline_taxes,903181);assert.equal(out.agency_fee,50000);
  assert.equal(out.ota_price,5152181);assert.equal(out.fare_family,'BUSINESS');
  assert.equal(back.price,5082181);assert.equal(out.price+back.price,snapshot.main_price);
  // Recorded contemporaneous web comparison, never a fixed assertion about future live prices.
  assert.equal(out.price,official.outbound.price);assert.equal(back.price,official.inbound.price);
  assert.equal(snapshot.main_price,official.total);
  assert.equal(out.base_fare+back.base_fare,official.base_fare);
  assert.equal(out.airline_taxes+back.airline_taxes,official.airline_surcharge+official.airport_and_government_taxes);
  assert.equal(out.ota_price+back.ota_price,official.total+out.agency_fee+back.agency_fee);
  assert.deepEqual([out.flight_number,back.flight_number],[official.outbound.flight,official.inbound.flight]);
  assert.deepEqual([out.departure,back.departure],[official.outbound.departure,official.inbound.departure]);
  assert.doesNotMatch(JSON.stringify(snapshot),/Session|Token|FlightValue/);
  const provider={id:'vna',name:'Vietnam Airlines',history:[snapshot]},text=formatDaily({providers:[provider],query});
  assert.match(text,/Cộng vé đi và về hiện là 10.184.362đ/);assert.doesNotMatch(text,/Vé khứ hồi hiện là/);
  assert.match(text,/VN1468.*15:50/);assert.match(text,/VN1469.*17:50/);
  assert.doesNotMatch(text,/Các chuyến có giá trong ngày/);
  assert.match(text,/Vietnam Airlines qua Flynow/);assert.match(text,/www.flynow.vn\/flights/);
  const alert=formatAlert(provider,snapshot,[{key:'baseline',guard:{kind:'main',price:snapshot.main_price}}]);
  assert.match(alert,/Tổng hai chiều/);assert.match(alert,/Vietnam Airlines qua Flynow/);
});
test('VNA rejects incompatible money, passengers, route, time and inventory and preserves partial legs',()=>{
  for(const modify of [f=>f.TotalTax++,f=>f.Adt=2,f=>f.TotalAirlineDiscount=1,
    f=>f.ListOption[0].ListFlight[0].Operating='VJ',f=>f.ListOption[0].ListFlight[0].StartPoint='HAN',
    f=>f.ListOption[0].ListFlight[0].EndDate='2027-02-04T99:99:99',f=>f.ListOption[0].ListFlight[0].StartDate='2027-02-03T15:50:00']){
    const p=structuredClone(sample);modify(p.ListFareData[0]);
    assert.throws(()=>normalizeSearch(p,query,query.departureDate,query.returnDate));
  }
  const p=structuredClone(sample);p.ListFareData[0].ListOption[0].ListFlight[0].ListSegment[0].SeatAvl=0;
  const quotes=normalizeSearch(p,query,query.departureDate,query.returnDate);
  assert.equal(quotes.outbound.length,0);assert.equal(quotes.inbound.length,1);
});
test('official diagnostic captures error fingerprints and allowlisted headers without saving raw HTML or credentials',async()=>{
  assert.deepEqual(fingerprint('<title>403 Forbidden</title><h1>Forbidden</h1>'),{title:'403 Forbidden',markers:['Forbidden'],error_codes:[]});
  const result=await diagnose({runId:'diagnostic-fixture',fetchImpl:async()=>new Response('<title>403 Forbidden</title>PRIVATE_BODY',{status:403,headers:{'content-type':'text/html','set-cookie':'PRIVATE_COOKIE','cf-ray':'fixture-ray'}})});
  assert.equal(result.results.length,3);assert.ok(result.results.every(r=>r.http_status===403&&r.body_sha256.length===64));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|set-cookie/);
});
