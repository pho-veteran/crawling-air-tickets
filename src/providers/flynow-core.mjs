import {queryId} from './vna-core.mjs';
import {trackingMode,trackedLegs} from '../shared/tracking.mjs';

export const ENDPOINT='https://www.flynow.vn/Handler/FlightHandler.ashx/ProcessRequest';
const wireDate=date=>date.split('-').reverse().join('');
export const sourcePage=query=>{const legs=trackedLegs(query);return 'https://www.flynow.vn/flights?'+new URLSearchParams({sp:legs[0].from,ep:legs[0].to,
  dt:legs.map(l=>wireDate(l.date)).join('.'),ps:query.adults+'.0.0'});};
export function requestFrom(query,departureDate=query.departureDate,returnDate=query.returnDate,system='EVJ'){
  return new URLSearchParams({requestType:'Search',searchType:'NORMAL',adt:query.adults,chd:0,inf:0,
    SpecialType:'',AgentCoupon:'',system,listFlight:JSON.stringify(trackedLegs({...query,departureDate,returnDate}).map((l,i)=>
      ({Leg:i,StartPoint:l.from,EndPoint:l.to,DepartDate:wireDate(l.date)})))});
}
function amount(value,label){
  if(!Number.isSafeInteger(value)||value<0)throw new Error('Flynow: trường tiền không hợp lệ: '+label);
  return value;
}
export function normalizeSearch(payload,query,departureDate,returnDate,observedAt=new Date().toISOString(),{airline='VJ',system='EVJ'}={}){
  if(payload.Status!==true||!Array.isArray(payload.ListFareData)){
    const code=/^[a-zA-Z0-9_-]{1,24}$/.test(String(payload.ErrorCode||''))?String(payload.ErrorCode):'unknown';
    throw Object.assign(new Error('Flynow '+system+': tìm kiếm chưa thành công (mã '+code+'); không suy diễn là hết vé.'),{sourceCode:code});
  }
  const quotes={outbound:[],inbound:[]};
  for(const fare of payload.ListFareData){
    if(fare.Airline!==airline)continue;
    if(fare.System!==system||fare.Currency!=='VND'||fare.Adt!==query.adults||fare.Chd!==0||fare.Inf!==0)
      throw new Error('Flynow: nguồn, tiền tệ hoặc số hành khách không khớp.');
    const base=amount(fare.TotalFare,'TotalFare'),tax=amount(fare.TotalTax,'TotalTax');
    const fee=amount(fare.TotalServiceFee,'TotalServiceFee'),discount=amount(fare.TotalAgentDiscount,'TotalAgentDiscount');
    const airlineDiscount=amount(fare.TotalAirlineDiscount,'TotalAirlineDiscount'),ota=amount(fare.TotalPrice,'TotalPrice');
    if(discount!==0||airlineDiscount!==0)throw new Error('Flynow: báo giá có chiết khấu chưa được xác minh.');
    const price=base+tax;
    if(!Number.isSafeInteger(price)||price<=0||ota!==price+fee||fare.PriceAdt!==fare.FareAdt+fare.TaxAdt+fare.ServiceFeeAdt||
      base!==fare.FareAdt*query.adults||tax!==fare.TaxAdt*query.adults||fee!==fare.ServiceFeeAdt*query.adults)
      throw new Error('Flynow: tổng giá không khớp giá vé + thuế + phí đại lý.');
    if(!Array.isArray(fare.ListOption))throw new Error('Flynow: thiếu lựa chọn chuyến bay.');
    for(const option of fare.ListOption){
      if(!Array.isArray(option.ListFlight)||option.ListFlight.length!==1)
        throw new Error('Flynow: báo giá ghép hành trình chưa được hỗ trợ.');
      const f=option.ListFlight[0],selected=trackedLegs({...query,departureDate,returnDate})[f.Leg],leg=selected?.leg;
      const expectedDate=selected?.date;
      if(!leg||fare.Itinerary!==f.Leg+1||f.Airline!==airline||f.Operating!==airline||
        f.StartPoint!==selected.from||f.EndPoint!==selected.to||
        f.StartDate?.slice(0,10)!==expectedDate)throw new Error('Flynow: chuyến bay sai tuyến, ngày hoặc chiều.');
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(f.StartDate||'')||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(f.EndDate||'')||
        !Number.isFinite(Date.parse(f.StartDate+'+07:00'))||!Number.isFinite(Date.parse(f.EndDate+'+07:00'))||Date.parse(f.EndDate+'+07:00')<=Date.parse(f.StartDate+'+07:00')||
        !new RegExp('^'+airline+'[0-9]+$').test(f.FlightNumber||''))throw new Error('Flynow: số chuyến hoặc giờ bay không hợp lệ.');
      if(f.StopNum!==0)continue;
      const segments=f.ListSegment;
      if(!Array.isArray(segments)||segments.length!==1)throw new Error('Flynow: thiếu chặng bay thẳng.');
      const segment=segments[0];
      if(segment.Status!=='OK'||!Number.isInteger(segment.SeatAvl)||segment.SeatAvl<query.adults)continue;
      quotes[leg].push({date:expectedDate,price,base_fare:base,airline_taxes:tax,agency_fee:fee,ota_price:ota,
        fare_family:airline==='VJ'?(segment.FareBasis==='YSBoss'?'SkyBoss':/ECO$/i.test(segment.FareBasis)?'Eco':/DLX$/i.test(segment.FareBasis)?'Deluxe':segment.FareType||segment.FareBasis||null):segment.FareType||segment.CabinName||segment.Cabin||segment.FareBasis||null,
        fare_basis:segment.FareBasis,booking_class:segment.Class||null,cabin:segment.CabinName||segment.Cabin||null,
        flight_number:f.FlightNumber,departure:f.StartDate,arrival:f.EndDate,time_zone:'Asia/Ho_Chi_Minh',
        baggage:segment.AllowanceBaggage,hand_baggage:segment.HandBaggage,observed_at:observedAt});
    }
  }
  return quotes;
}
export async function fetchSearch(query,departureDate,returnDate,fetchImpl=fetch,provider={}){
  const response=await fetchImpl(ENDPOINT,{method:'POST',body:requestFrom(query,departureDate,returnDate,provider.system||'EVJ'),
    signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw new Error('Flynow: HTTP '+response.status+'; đã dừng, không retry.');}
  if(!/json/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new Error('Flynow: nguồn không trả JSON.');}
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Flynow: response vượt 2 MiB.');chunks.push(chunk);}
  return {quotes:normalizeSearch(JSON.parse(Buffer.concat(chunks).toString('utf8')),query,departureDate,returnDate,new Date().toISOString(),provider),bytes};
}
export async function crawlProvider(query,provider,{fetchImpl=fetch}={}){
  if(query.adults!==1||![query.origin,query.destination].every(c=>['SGN','VCL'].includes(c))||query.origin===query.destination)
    throw new Error(provider.name+' qua Flynow: hiện chỉ xác minh SGN ⇄ VCL, 1 người lớn.');
  const start=Date.now();let result;
  try{result=await fetchSearch(query,query.departureDate,query.returnDate,fetchImpl,provider);}
  catch(error){error.requests=1;throw error;}
  const legs={};
  for(const {leg,date} of trackedLegs(query)){
    const flights=result.quotes[leg].sort((a,b)=>a.price-b.price||a.departure.localeCompare(b.departure)||String(a.fare_basis).localeCompare(String(b.fare_basis)));
    legs[leg]=[flights.length?{...flights[0],flights}:{date,price:null,fare_family:null,flights:[]}];
  }
  if(!Object.values(legs).some(([q])=>q.price!==null)){
    const error=new Error(provider.name+' qua Flynow: không có báo giá phù hợp; không kết luận hết vé.');error.requests=1;throw error;
  }
  const selected=Object.values(legs).map(([q])=>q.price);
  const price=selected.some(p=>p===null)?null:selected.reduce((a,b)=>a+b,0);
  // One compatibility cell is the chosen date pair. There is no nearby calendar.
  const cells=trackingMode(query)==='roundtrip'?[{depart:query.departureDate,return:query.returnDate,state:price===null?'unknown':'available',price}]:[];
  return {schema:1,source:provider.source,query_id:queryId(query,provider.source),query,observed_at:new Date().toISOString(),
    status:price===null?'partial':'ok',currency:'VND',taxes_included:true,scope:'selected-dates',
    price_basis:trackingMode(query)==='roundtrip'?'sum-of-oneway-airline-fares-excluding-agency-fee':'oneway-airline-fare-excluding-agency-fee',agency:'Flynow',supplier_system:provider.system,
    adjustment_method:'TotalPrice - TotalServiceFee = TotalFare + TotalTax; zero discounts required',
    main_price:price,minimum_price:price,cells,legs,leg_errors:{},date_errors:{},
    source_pages:[sourcePage(query)],requests:1,duration_ms:Date.now()-start,response_bytes:result.bytes};
}
