import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crawl,crawlBestprice,crawlAbay} from '../src/providers/vna-agencies.mjs';
import {simulatedSources} from '../scripts/fixtures/agencies.mjs';
import {queryFrom} from '../src/providers/vna-core.mjs';
import config from '../config.json' with {type:'json'};

const query=queryFrom(config),leg={leg:'inbound',from:'VCL',to:'SGN',date:'2027-02-13'};
const pending={search_status:'CONTINUE',search_data:{flight_items:[],previous_flights:'prior',time_first_call:'first'}};
const done={search_status:'DONE',search_data:{flight_data:[]}};
const flight={Airlines:'VN',From:'VCL',To:'SGN',Stop:0,FlightNumber:'VN1469',DateFrom:'2027-02-13 06:00:00',DateTo:'2027-02-13 07:20:00',PriceInfo:[{Seat:8,Class:'J',ADT_Fare:1800000,ADT_Tax:600000,BP_Fee:0,BP_Discount:0,BP_Discount_Total:0}]};
function bestpriceFetch(responses){
  let poll=0;return async url=>{
    const path=new URL(url).pathname;
    if(path==='/get-vnisc-sid.html')return Response.json({vnisc_sid:'fixture'});
    if(path==='/ajax-search-flight-bp')return Response.json(responses[poll++] ?? responses.at(-1));
    return new Response('<input id="sid" value="fixture"><input id="search_flight_url" value="From_Code=VCL">');
  };
}
async function withTimers(t,operation){
  t.mock.timers.enable({apis:['setTimeout']});
  const result=operation().then(value=>({value}),error=>({error}));
  for(let i=0;i<10;i++){await new Promise(resolve=>setImmediate(resolve));t.mock.timers.runAll();}
  const outcome=await result;if(outcome.error)throw outcome.error;return outcome.value;
}
test('BestPrice continues pending searches to priced or completed empty outcomes',async t=>{
  for(const final of [{search_status:'CONTINUE',search_data:{flight_data:[flight]}},{search_status:'DONE',search_data:{flight_data:[flight]}},done]){
    const result=await withTimers(t,()=>crawlBestprice(leg,{fetchImpl:bestpriceFetch([pending,final])}));
    assert.equal(result.flights.length,final===done?0:1);assert.ok(Number.isFinite(Date.parse(result.observed_at)));
    t.mock.timers.reset();
  }
});
test('BestPrice pending exhaustion is an error, not an empty search',async t=>{
  await assert.rejects(withTimers(t,()=>crawlBestprice(leg,{fetchImpl:bestpriceFetch([pending])})),/did not complete/);
});
test('BestPrice rejects failed, unknown and incomplete terminal schemas',async()=>{
  for(const response of [
    {search_status:'FAILED',search_data:{flight_data:[flight]}},
    {search_status:'UNKNOWN',search_data:{flight_data:[]}},
    {search_status:'DONE',search_data:{flight_items:[]}},
    {search_status:'DONE',exception_html:'search failed',search_data:{flight_data:[]}},
    {search_status:'CONTINUE',search_data:{}},
  ])await assert.rejects(crawlBestprice(leg,{fetchImpl:bestpriceFetch([response])}));
});
test('BestPrice completed zero-seat fare is empty',async()=>{
  const sold=structuredClone(flight);sold.PriceInfo[0].Seat=0;
  const result=await crawlBestprice(leg,{fetchImpl:bestpriceFetch([{search_status:'DONE',search_data:{flight_data:[sold]}}])});
  assert.deepEqual(result.flights,[]);
});
test('BestPrice malformed flight or seat fields never become completed empty results',async()=>{
  const badSeats=[undefined,'0',-1];
  const flights=[{},...badSeats.map(Seat=>({...flight,PriceInfo:[{...flight.PriceInfo[0],Seat}]}))];
  for(const f of flights)await assert.rejects(crawlBestprice(leg,{fetchImpl:bestpriceFetch([{search_status:'DONE',search_data:{flight_data:[f]}}])}));
});
function abayFetch(data){
  const source=simulatedSources(query);
  return async (url,options)=>new URL(url).pathname.endsWith('/GetFlights')?Response.json({d:JSON.stringify({D:data})}):source.fetch(url,options);
}
test('ABAY accepts valid empty results and rejects VN candidates without details',async()=>{
  const result=await crawlAbay(leg,{fetchImpl:abayFetch([])});
  assert.deepEqual(result.flights,[]);assert.ok(Number.isFinite(Date.parse(result.observed_at)));
  await assert.rejects(crawlAbay(leg,{fetchImpl:abayFetch([{E:'VN'}])}),/detail unavailable/);
});
test('ABAY malformed flight entries never become completed empty results',async()=>{
  await assert.rejects(crawlAbay(leg,{fetchImpl:abayFetch([{}])}));
});
test('ABAY completed zero-seat fare is empty',async()=>{
  const source=simulatedSources(query);
  const fetchImpl=async(url,options)=>{
    const response=await source.fetch(url,options);
    if(!new URL(url).pathname.endsWith('/GetFlights'))return response;
    const body=await response.json(),data=JSON.parse(body.d);data.D[0].N=data.D[0].N.replace('SeatRemain8-0','SeatRemain0-0');
    return Response.json({d:JSON.stringify(data)});
  };
  assert.deepEqual((await crawlAbay(leg,{fetchImpl})).flights,[]);
});
test('empty agency outcomes are deliverable, while all errors fail',async()=>{
  const observed='2026-10-22T07:40:00.000Z';
  const empty=async()=>({flights:[],observed_at:observed,requests:0,bytes:0});
  const fail=async()=>{throw new Error('BestPrice unavailable');};
  const emptyAbay=abayFetch([]),failedAbay=async()=>new Response('',{status:503});
  for(const [bestpriceImpl,abayFetchImpl,statuses] of [[empty,emptyAbay,['empty','empty']],[empty,failedAbay,['empty','error']],[fail,emptyAbay,['empty','error']]]){
    const record=await crawl(query,{bestpriceImpl,abayFetchImpl});
    assert.equal(record.status,'partial');assert.equal(record.main_price,null);
    assert.deepEqual(record.agency_quotes.map(q=>q.status).sort(),statuses);
    assert.deepEqual(record.legs.inbound,[{date:query.returnDate,price:null,flights:[]}]);
    const timestamps=record.agency_quotes.filter(q=>q.status==='empty').map(q=>q.observed_at).sort();
    assert.equal(record.observed_at,timestamps[0]);
  }
  await assert.rejects(crawl(query,{bestpriceImpl:fail,abayFetchImpl:failedAbay}),/BestPrice and ABAY/);
});
