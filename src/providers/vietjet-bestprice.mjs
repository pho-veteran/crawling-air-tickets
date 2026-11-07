import {queryId} from './vna-core.mjs';
import {trackedLegs} from '../shared/tracking.mjs';

export const SOURCE='vietjet-bestprice-selected-flight-fares-v1';
export const BASIS='BestPrice reported Vietjet fare plus taxes, excluding the itemized agency fee; search may be incomplete.';
const base='https://www.bestprice.vn';
const cities={VCL:'Chu Lai (VCL)',SGN:'Ho Chi Minh (SGN)'};
const decode=s=>String(s).replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#039;',"'");
const attr=(tag,key)=>decode(String(tag||'').match(new RegExp('(?:^|\\s)'+key+'=(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'))?.slice(1).find(x=>x!==undefined)||'');
const money=(n,label)=>{if(!Number.isSafeInteger(n)||n<0)throw new Error('BestPrice invalid '+label);return n;};
function validDate(date){return /^\d{4}-\d{2}-\d{2}$/.test(date||'')&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;}
function datetime(s){if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s||'')||!validDate(s.slice(0,10))||!Number.isFinite(Date.parse(s.replace(' ','T')+'+07:00')))throw new Error('BestPrice invalid flight time');return s.replace(' ','T');}
export function sourcePage(leg,adults=1){return base+'/ve-may-bay/tim-kiem-ve?'+new URLSearchParams({From:cities[leg.from],From_Code:leg.from,To:cities[leg.to],To_Code:leg.to,Depart:leg.date.split('-').reverse().join('/'),Return:'',ADT:String(adults),CHD:'0',INF:'0',is_search_cheapest:'0',Airline:'VJ'});}
export function normalizeSearch(payload,leg,observedAt=new Date().toISOString()){
  if(!['CONTINUE','DONE'].includes(payload.search_status)||payload.exception_html)throw new Error('BestPrice search failed');
  const d=payload.search_data,c=d?.search_criteria;
  if(!c||c.Type!=='oneway'||c.From_Code!==leg.from||c.To_Code!==leg.to||c.Depart!==leg.date.split('-').reverse().join('/')||c.Return!==''||String(c.ADT)!=='1'||String(c.CHD)!=='0'||String(c.INF)!=='0'||c.is_domistic!=='1'||!Array.isArray(d.flight_data))throw new Error('BestPrice search criteria mismatch');
  const flights=[];
  for(const f of d.flight_data){
    if(typeof f?.Airlines!=='string'||!Number.isSafeInteger(f.Stop)||f.Stop<0)throw new Error('BestPrice flight schema changed');
    if(f.Airlines!=='VJ'||f.Stop!==0)continue;
    const departure=datetime(f.DateFrom),arrival=datetime(f.DateTo);
    if(f.From!==leg.from||f.To!==leg.to||departure.slice(0,10)!==leg.date||arrival<=departure||!/^VJ-?\d+$/.test(f.FlightNumber||'')||!Array.isArray(f.PriceInfo))throw new Error('BestPrice flight itinerary mismatch');
    for(const p of f.PriceInfo){
      if(!Number.isSafeInteger(p?.Seat)||p.Seat<0)throw new Error('BestPrice invalid seat count');
      if(p.Seat<1)continue;
      const fare=money(p.ADT_Fare,'fare'),tax=money(p.ADT_Tax,'tax'),fee=money(p.BP_Fee,'fee');
      if(!fare||money(p.BP_Discount,'discount')!==0||money(p.BP_Discount_Total,'discount total')!==0||!Number.isSafeInteger(fare+tax+fee))throw new Error('BestPrice discounted or invalid fare');
      if(typeof p.Class!=='string'||!p.Class||typeof p.FareClass!=='string'||!p.FareClass)throw new Error('BestPrice missing fare class');
      const flight_number=f.FlightNumber.replace('-',''),duration=(Date.parse(arrival+'+07:00')-Date.parse(departure+'+07:00'))/60000;
      flights.push({date:leg.date,price:fare+tax,base_fare:fare,airline_taxes:tax,agency_fee:fee,ota_price:fare+tax+fee,fare_family:p.FareClass,fare_basis:p.Class,booking_class:null,cabin:null,flight_number,departure,arrival,segments:[{from:leg.from,to:leg.to,flight_number,departure,arrival}],stops:0,total_duration_minutes:duration,time_zone:'Asia/Ho_Chi_Minh',baggage:p.AllowanceBaggage||null,hand_baggage:p.HandBaggage||null,observed_at:observedAt});
    }
  }
  return flights.sort((a,b)=>a.price-b.price||a.departure.localeCompare(b.departure)||a.fare_basis.localeCompare(b.fare_basis));
}
export async function crawl(query,{fetchImpl=fetch}={}){
  if(!cities[query.origin]||!cities[query.destination]||query.origin===query.destination||query.adults!==1||(query.currency??'VND')!=='VND'||!validDate(query.departureDate)||!validDate(query.returnDate)||query.returnDate<=query.departureDate)throw new Error('BestPrice supports SGN and VCL, one adult, VND and valid dates');
  const tracked=trackedLegs(query),start=Date.now();let requests=0,bytes=0;
  async function searchLeg(leg){
  const page=sourcePage(leg),jar=new Map();
  async function get(url){
    if(new URL(url).origin!==base)throw new Error('BestPrice unexpected origin');
    requests++;const response=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(25000),headers:jar.size?{cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}});
    for(const c of response.headers.getSetCookie?.()||[]){const pair=c.split(';')[0],i=pair.indexOf('=');if(i>0)jar.set(pair.slice(0,i),pair.slice(i+1));}
    if(!response.ok){await response.body?.cancel();throw new Error('BestPrice HTTP '+response.status);}
    const chunks=[];let size=0;for await(const chunk of response.body||[]){size+=chunk.length;if(size>1024*1024)throw new Error('BestPrice response exceeds 1 MiB');chunks.push(chunk);}bytes+=size;return Buffer.concat(chunks).toString('utf8');
  }
  try{
    const html=await get(page),inputs=[...html.matchAll(/<input\b[^>]*>/gi)].map(m=>m[0]),value=id=>attr(inputs.find(t=>attr(t,'id')===id),'value');
    const sid=value('sid'),search=value('search_flight_url');if(!sid||!search||value('currency_unit')!=='đ')throw new Error('BestPrice search form or VND currency unavailable');
    const session=JSON.parse(await get(base+'/get-vnisc-sid.html?sid='+encodeURIComponent(sid)+'&'+search));if(typeof session.vnisc_sid!=='string'||!session.vnisc_sid)throw new Error('BestPrice search session unavailable');
    let previous='',time='',payload,flights;
    for(let i=0;i<3;i++){
      const params=new URLSearchParams(search);for(const [k,v] of Object.entries({sid,vnisc_sid:session.vnisc_sid,previous_flights:previous,flight_type:'depart',previous_airline:'',time_first_call:time,airline_search:'VJ'}))params.set(k,v);
      payload=JSON.parse(await get(base+'/ajax-search-flight-bp?'+params));
      const d=payload.search_data,pending=payload.search_status==='CONTINUE'&&!payload.exception_html&&d&&((Array.isArray(d.flight_items)&&d.flight_items.length===0&&d.flight_data===undefined)||(Array.isArray(d.flight_data)&&d.flight_data.length===0));
      if(!pending){flights=normalizeSearch(payload,leg);break;}
      previous=d.previous_flights||'';time=d.time_first_call||'';
      if(i<2)await new Promise(resolve=>setTimeout(resolve,1000));
    }
    if(!flights)throw new Error('BestPrice search did not return flights');
    const price=flights.length?flights[0].price:null;
    return {leg,page,payload,quote:{date:leg.date,price,...(price===null?{}:flights[0]),flights}};
  }catch(error){return {leg,page,error};}
  }
  const results=await Promise.all(tracked.map(searchLeg)),successful=results.filter(x=>!x.error);
  if(!successful.length){const error=results[0].error;error.requests=requests;throw error;}
  const legs={},leg_errors={};
  for(const r of results){legs[r.leg.leg]=[r.quote||{date:r.leg.date,price:null,flights:[]}];if(r.error)leg_errors[r.leg.leg]=r.error.message;}
  const prices=results.map(r=>r.quote?.price??null),price=prices.every(x=>x!==null)?prices.reduce((a,b)=>a+b,0):null;
  const roundtrip=tracked.length===2;
  return {schema:1,source:SOURCE,query_id:queryId(query,SOURCE),query,observed_at:new Date().toISOString(),status:price===null?'partial':'ok',currency:'VND',taxes_included:true,scope:'selected-dates',price_basis:'oneway-airline-fare-excluding-agency-fee',agency:'BestPrice',search_status:successful.length===1?successful[0].payload.search_status:undefined,main_price:price,minimum_price:price,cells:roundtrip?[{depart:query.departureDate,return:query.returnDate,state:price===null?'unknown':'available',price}]:[],legs,leg_errors,date_errors:{},source_pages:results.map(r=>r.page),requests,duration_ms:Date.now()-start,response_bytes:bytes};
}
