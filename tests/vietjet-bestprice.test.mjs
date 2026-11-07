import test from 'node:test';
import assert from 'node:assert/strict';
import {crawl,normalizeSearch,SOURCE} from '../src/providers/vietjet-bestprice.mjs';

const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-10',trackingMode:'inbound',adults:1,currency:'VND'};
const leg={from:'VCL',to:'SGN',date:'2027-02-10'};
const payload=()=>({search_status:'CONTINUE',exception_html:'',search_data:{search_criteria:{Type:'oneway',From_Code:'VCL',To_Code:'SGN',Depart:'10/02/2027',Return:'',ADT:'1',CHD:'0',INF:'0',is_domistic:'1'},flight_data:[{Airlines:'VJ',Stop:0,From:'VCL',To:'SGN',FlightNumber:'VJ-371',DateFrom:'2027-02-10 07:50:00',DateTo:'2027-02-10 09:10:00',PriceInfo:[{Seat:4,ADT_Fare:3990000,ADT_Tax:880781,BP_Fee:100000,BP_Discount:0,BP_Discount_Total:0,Class:'YSBoss',FareClass:'SkyBoss',AllowanceBaggage:'1 item x 30kg',HandBaggage:'1 item x 10kg'}]}]}});
function fakeFetch(data=payload(),currency='đ'){
  let calls=0;return async url=>{calls++;if(calls===1)return new Response(`<input id="sid" value="s"><input id="search_flight_url" value="From_Code=VCL&amp;To_Code=SGN"><input id="currency_unit" value="${currency}">`);if(calls===2)return Response.json({vnisc_sid:'session'});assert.match(url,/airline_search=VJ/);return Response.json(data);};
}
test('BestPrice normalizes fare and separates agency fee',async()=>{
  const r=await crawl(query,{fetchImpl:fakeFetch()});assert.equal(r.source,SOURCE);assert.equal(r.status,'ok');assert.equal(r.search_status,'CONTINUE');assert.equal(r.main_price,4870781);assert.deepEqual(r.cells,[]);const f=r.legs.inbound[0].flights[0];assert.equal(f.base_fare,3990000);assert.equal(f.airline_taxes,880781);assert.equal(f.agency_fee,100000);assert.equal(f.ota_price,4970781);assert.equal(f.flight_number,'VJ371');assert.equal(f.fare_family,'SkyBoss');assert.equal(f.baggage,'1 item x 30kg');
});
test('BestPrice rejects invalid criteria, prices and availability',()=>{
  for(const change of [d=>d.search_data.search_criteria.Depart='11/02/2027',d=>d.search_data.search_criteria.ADT='2',d=>d.search_data.flight_data[0].From='SGN',d=>d.search_data.flight_data[0].PriceInfo[0].BP_Discount=1,d=>d.search_data.flight_data[0].PriceInfo[0].ADT_Tax=1.5,d=>d.search_data.flight_data[0].PriceInfo[0].Seat=-1]){const d=payload();change(d);assert.throws(()=>normalizeSearch(d,leg));}
  const d=payload();d.search_data.flight_data[0].PriceInfo[0].Seat=0;assert.deepEqual(normalizeSearch(d,leg),[]);
});
test('BestPrice validates requested currency and query',async()=>{
  await assert.rejects(crawl({...query,currency:'USD'},{fetchImpl:fakeFetch()}));await assert.rejects(crawl(query,{fetchImpl:fakeFetch(payload(),'$')}));await assert.rejects(crawl({...query,returnDate:'2027-02-30'},{fetchImpl:fakeFetch()}));
});

test('pending empty flight data is polled rather than classified as completed',async()=>{
  let calls=0;const pending=payload();pending.search_data.flight_data=[];
  const completed=payload();completed.search_status='DONE';
  const fetchImpl=async url=>{
    calls++;
    if(calls===1)return new Response('<input id="sid" value="s"><input id="search_flight_url" value="From_Code=VCL&amp;To_Code=SGN"><input id="currency_unit" value="đ">');
    if(calls===2)return Response.json({vnisc_sid:'session'});
    return Response.json(calls===3?pending:completed);
  };
  const r=await crawl(query,{fetchImpl});assert.equal(r.main_price,4870781);assert.equal(r.search_status,'DONE');assert.equal(calls,4);
});
test('exhausted pending empty search is an error, not a completed no-fare search',async()=>{
  const pending=payload();pending.search_data.flight_data=[];
  await assert.rejects(crawl(query,{fetchImpl:fakeFetch(pending)}),/did not return flights/);
});
test('completed empty search returns a partial no-fare record',async()=>{
  const done=payload();done.search_status='DONE';done.search_data.flight_data=[];
  const r=await crawl(query,{fetchImpl:fakeFetch(done)});assert.equal(r.status,'partial');assert.equal(r.main_price,null);
});
