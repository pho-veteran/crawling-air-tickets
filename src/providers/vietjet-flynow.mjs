import {dateRange,queryId} from './vna.mjs';

export const SOURCE='vietjet-flynow-airline-fare-v1';
export const ENDPOINT='https://www.flynow.vn/Handler/FlightHandler.ashx/ProcessRequest';
export const BASIS='Giá Vietjet qua Flynow, gồm thuế/phí hãng; loại phí dịch vụ đại lý theo từng báo giá. Bảng lân cận cộng hai vé một chiều độc lập, chưa giữ chỗ.';
const wireDate=date=>date.split('-').reverse().join('');
export function requestFrom(query,departureDate=query.departureDate,returnDate=query.returnDate){
  return new URLSearchParams({requestType:'Search',searchType:'NORMAL',adt:query.adults,chd:0,inf:0,
    SpecialType:'',AgentCoupon:'',system:'EVJ',listFlight:JSON.stringify([
      {Leg:0,StartPoint:query.origin,EndPoint:query.destination,DepartDate:wireDate(departureDate)},
      {Leg:1,StartPoint:query.destination,EndPoint:query.origin,DepartDate:wireDate(returnDate)}])});
}
export const sourcePage=query=>'https://www.flynow.vn/flights?'+new URLSearchParams({sp:query.origin,ep:query.destination,
  dt:wireDate(query.departureDate)+'.'+wireDate(query.returnDate),ps:query.adults+'.0.0'});
function amount(value,label){
  if(!Number.isSafeInteger(value)||value<0)throw new Error('Flynow: trường tiền không hợp lệ: '+label);
  return value;
}
export function normalizeSearch(payload,query,departureDate,returnDate,observedAt=new Date().toISOString()){
  if(payload.Status!==true||!Array.isArray(payload.ListFareData))throw new Error('Flynow: tìm kiếm chưa thành công; không suy diễn là hết vé.');
  const quotes={outbound:[],inbound:[]};
  for(const fare of payload.ListFareData){
    if(fare.Airline!=='VJ')continue;
    if(fare.System!=='EVJ'||fare.Currency!=='VND'||fare.Adt!==query.adults||fare.Chd!==0||fare.Inf!==0)
      throw new Error('Flynow: nguồn, tiền tệ hoặc số hành khách không khớp.');
    const base=amount(fare.TotalFare,'TotalFare'),tax=amount(fare.TotalTax,'TotalTax');
    const fee=amount(fare.TotalServiceFee,'TotalServiceFee'),discount=amount(fare.TotalAgentDiscount,'TotalAgentDiscount');
    const airlineDiscount=amount(fare.TotalAirlineDiscount,'TotalAirlineDiscount'),ota=amount(fare.TotalPrice,'TotalPrice');
    // Discount semantics are unverified: fail closed instead of guessing a net fare.
    if(discount!==0||airlineDiscount!==0)throw new Error('Flynow: báo giá có chiết khấu chưa được xác minh.');
    const price=base+tax;
    if(price<=0||ota!==price+fee||fare.PriceAdt!==fare.FareAdt+fare.TaxAdt+fare.ServiceFeeAdt||
      base!==fare.FareAdt*query.adults||tax!==fare.TaxAdt*query.adults||fee!==fare.ServiceFeeAdt*query.adults)
      throw new Error('Flynow: tổng giá không khớp giá vé + thuế + phí đại lý.');
    if(!Array.isArray(fare.ListOption))throw new Error('Flynow: thiếu lựa chọn chuyến bay.');
    for(const option of fare.ListOption){
      if(!Array.isArray(option.ListFlight)||option.ListFlight.length!==1)
        throw new Error('Flynow: báo giá ghép hành trình chưa được hỗ trợ.');
      const f=option.ListFlight[0],leg=f.Leg===0?'outbound':f.Leg===1?'inbound':null;
      const expectedDate=f.Leg===0?departureDate:returnDate;
      if(!leg||fare.Itinerary!==f.Leg+1||f.Airline!=='VJ'||f.Operating!=='VJ'||
        f.StartPoint!==(f.Leg===0?query.origin:query.destination)||f.EndPoint!==(f.Leg===0?query.destination:query.origin)||
        f.StartDate?.slice(0,10)!==expectedDate)throw new Error('Flynow: chuyến bay sai tuyến, ngày hoặc chiều.');
      if(f.StopNum!==0)continue;
      const segments=f.ListSegment;
      if(!Array.isArray(segments)||segments.length!==1)throw new Error('Flynow: thiếu chặng bay thẳng.');
      const segment=segments[0];
      if(segment.Status!=='OK'||!Number.isInteger(segment.SeatAvl)||segment.SeatAvl<query.adults)continue;
      quotes[leg].push({date:expectedDate,price,base_fare:base,airline_taxes:tax,agency_fee:fee,ota_price:ota,
        fare_family:segment.FareBasis==='YSBoss'?'SkyBoss':/ECO$/i.test(segment.FareBasis)?'Eco':/DLX$/i.test(segment.FareBasis)?'Deluxe':segment.FareType||segment.FareBasis||null,
        fare_basis:segment.FareBasis,flight_number:f.FlightNumber,departure:f.StartDate,arrival:f.EndDate,
        baggage:segment.AllowanceBaggage,hand_baggage:segment.HandBaggage,observed_at:observedAt});
    }
  }
  return quotes;
}
export async function fetchSearch(query,departureDate,returnDate,fetchImpl=fetch){
  const response=await fetchImpl(ENDPOINT,{method:'POST',body:requestFrom(query,departureDate,returnDate),
    signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw new Error('Flynow: HTTP '+response.status+'; đã dừng, không retry.');
  if(!/json/i.test(response.headers.get('content-type')||''))throw new Error('Flynow: nguồn không trả JSON.');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Flynow: response vượt 2 MiB.');chunks.push(chunk);}
  return {quotes:normalizeSearch(JSON.parse(Buffer.concat(chunks).toString('utf8')),query,departureDate,returnDate),bytes};
}
export async function crawl(query,{fetchImpl=fetch}={}){
  if(query.adults!==1||![query.origin,query.destination].every(c=>['SGN','VCL'].includes(c))||query.origin===query.destination)
    throw new Error('Vietjet qua Flynow: hiện chỉ xác minh SGN ⇄ VCL, 1 người lớn.');
  const start=Date.now(),departures=dateRange(query.departureDate),returns=dateRange(query.returnDate);
  const legs={outbound:[],inbound:[]},dateErrors={},legErrors={};let requests=0,bytes=0;
  // Seven searches supply fourteen independent one-way dates, then form a 7×7 table.
  // At most two searches in flight; no calendar teaser prices or fallback source.
  const indices=[3,0,1,2,4,5,6];let next=0;
  async function worker(){
    while(next<indices.length){
      const i=indices[next++];requests++;
      try{
        const result=await fetchSearch(query,departures[i],returns[i],fetchImpl);bytes+=result.bytes;
        for(const leg of ['outbound','inbound']){
          const flights=result.quotes[leg].sort((a,b)=>a.price-b.price||a.departure.localeCompare(b.departure));
          legs[leg].push(flights.length?{...flights[0],flights}:{date:leg==='outbound'?departures[i]:returns[i],price:null,fare_family:null});
        }
      }catch(error){
        dateErrors[departures[i]+'|'+returns[i]]=String(error.message).slice(0,200);
        for(const leg of ['outbound','inbound'])legs[leg].push({date:leg==='outbound'?departures[i]:returns[i],price:null,fare_family:null});
        if(i===3)for(const leg of ['outbound','inbound'])legErrors[leg]=String(error.message).slice(0,200);
        if(/HTTP (403|429)/.test(error.message))next=indices.length;
      }
    }
  }
  await Promise.all([worker(),worker()]);
  for(const [leg,dates] of [['outbound',departures],['inbound',returns]]){
    const found=new Map(legs[leg].map(q=>[q.date,q]));
    legs[leg]=dates.map(date=>found.get(date)||{date,price:null,fare_family:null});
  }
  if(!Object.values(legs).flat().some(q=>q.price!==null)){
    const error=new Error('Vietjet qua Flynow: chưa lấy được giá. '+(Object.values(dateErrors)[0]||'Không có báo giá phù hợp.'));error.requests=requests;throw error;
  }
  const cells=legs.outbound.flatMap(d=>legs.inbound.map(r=>({depart:d.date,return:r.date,
    state:d.date>=r.date?'disabled':d.price===null||r.price===null?'unknown':'available',
    price:d.date>=r.date||d.price===null||r.price===null?null:d.price+r.price})));
  const prices=cells.filter(c=>c.price!==null).map(c=>c.price);
  return {schema:1,source:SOURCE,query_id:queryId(query,SOURCE),query,observed_at:new Date().toISOString(),
    status:cells.some(c=>c.state==='unknown')?'partial':'ok',currency:'VND',taxes_included:true,
    price_basis:'sum-of-oneway-airline-fares-excluding-agency-fee',agency:'Flynow',
    adjustment_method:'TotalPrice - TotalServiceFee = TotalFare + TotalTax; zero discounts required',
    main_price:cells.find(c=>c.depart===query.departureDate&&c.return===query.returnDate)?.price??null,
    minimum_price:prices.length?Math.min(...prices):null,cells,legs,leg_errors:legErrors,date_errors:dateErrors,
    source_pages:[sourcePage(query)],requests,duration_ms:Date.now()-start,response_bytes:bytes};
}
