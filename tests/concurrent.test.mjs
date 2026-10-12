import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crawl as crawlVna, dateRange} from '../src/providers/vna.mjs';
import {crawl as crawlVj} from '../src/providers/vietjet.mjs';

const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const shift=(date,days)=>new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10);
const week=date=>Array.from({length:7},(_,i)=>shift(date,i));

function matrixBody(){
  const deps=dateRange(query.departureDate),rets=dateRange(query.returnDate);
  return JSON.stringify({success:true,data:{currencyCode:'VND',dictionaries:{currency:{VND:{decimalPlaces:0}}},
    departureDates:deps,returnDates:rets,
    rows:deps.map(d=>({departureDate:d,cells:rets.map(r=>({departureDate:d,returnDate:r,available:true,totalPrice:10184362,currencyCode:'VND'}))}))}});
}
function onewayBody(dates){
  return JSON.stringify({success:true,data:{dictionaries:{currency:{VND:{decimalPlaces:0}}},
    prices:dates.map(date=>({departureDate:date,price:[{base:'4000000',totalTaxes:'1333181',total:'5333181',currencyCode:'VND'}]}))}});
}
function vjPage(from,to,dates){
  return 'Giá vé chỉ áp dụng cho chuyến bay một chiều'+dates.map(d=>
    `<div class="price-calendar" data-startdate="${d}" data-origin="${from}" data-destination="${to}" data-currency="VND" data-triptype="oneway"><span class="price-bold">1 670 000</span><span class="price-sm">VND</span><div class="time-calendar">`).join('');
}
// Mock fetch that parks every request at a gate, so the test can observe overlap.
function gateFetch(respond){
  let inflight=0,max=0;const started=[];
  let release;const gate=new Promise(r=>release=r);
  const fetchImpl=async(url,opts)=>{started.push(url);inflight++;max=Math.max(max,inflight);await gate;inflight--;return respond(url,opts);};
  return {fetchImpl,started,stats:()=>({max}),release};
}
const ticks=async(n=5)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const json=data=>new Response(data,{headers:{'content-type':'application/json'}});
const html=data=>new Response(data,{headers:{'content-type':'text/html'}});

function vnaRespond(url,opts){
  const body=JSON.parse(opts.body);
  if(body.route)return json(onewayBody(week(body.route.departureDateTime)));
  return json(matrixBody());
}
function vjRespond(url){
  return html(url.includes('tp-ho-chi-minh-di-chu-lai')
    ? vjPage('SGN','VCL',dateRange(query.departureDate))
    : vjPage('VCL','SGN',dateRange(query.returnDate)));
}

test('vna fires matrix and one-way legs at once',async()=>{
  const g=gateFetch(vnaRespond);
  const pending=crawlVna(query,{fetchImpl:g.fetchImpl});
  await ticks();
  assert.equal(g.started.length,3);
  g.release();
  const rec=await pending;
  assert.equal(g.stats().max,3);
  assert.equal(rec.status,'ok');
  assert.equal(rec.main_price,10184362);
  assert.equal(rec.legs.outbound.find(d=>d.date===query.departureDate).price,5333181);
});

test('vietjet fires both directions at once',async()=>{
  const g=gateFetch(vjRespond);
  const pending=crawlVj(query,{fetchImpl:g.fetchImpl});
  await ticks();
  assert.equal(g.started.length,2);
  g.release();
  const rec=await pending;
  assert.equal(g.stats().max,2);
  assert.equal(rec.status,'ok');
  assert.equal(rec.main_price,3340000);
});
