import {queryId} from './vna-core.mjs';
import {fetchOneWay} from './vna-oneway.mjs';
import {trackedLegs,trackingMode} from '../shared/tracking.mjs';

export const SOURCE='vna-official-selected-prices-v1';
export const BASIS='official-oneway-calendar-tax-inclusive';
export async function crawl(query,{fetchImpl=fetch}={}){
  if(query.adults!==1||query.currency!=='VND'||query.origin===query.destination||![query.origin,query.destination].every(c=>['SGN','VCL'].includes(c)))throw new Error('VNA official reference supports SGN/VCL, one adult, VND');
  const started=Date.now(),legs={},legErrors={};let requests=0,bytes=0;
  for(const leg of trackedLegs(query)){
    requests++;
    try{
      const result=await fetchOneWay(leg.from,leg.to,[leg.date],fetchImpl);bytes+=result.bytes;
      const q=result.dates[0];
      legs[leg.leg]=[{date:leg.date,price:q.price,base_fare:q.base,airline_taxes:q.taxes,flights:[],observed_at:q.observed_at,reference_only:true}];
    }catch(error){legErrors[leg.leg]=String(error.message).slice(0,200);}
  }
  if(!Object.keys(legs).length)throw Object.assign(new Error('VNA official reference unavailable: '+Object.values(legErrors).join('; ')),{requests});
  const values=trackedLegs(query).map(l=>legs[l.leg]?.[0].price),price=values.every(p=>Number.isSafeInteger(p)&&p>0)?values.reduce((a,b)=>a+b,0):null;
  const observed_at=Object.values(legs).map(q=>q[0].observed_at).sort()[0];
  return {schema:1,source:SOURCE,query_id:queryId(query,SOURCE),query,observed_at,status:Object.keys(legErrors).length||price===null?'partial':'ok',currency:'VND',taxes_included:true,scope:'selected-dates',price_basis:BASIS,agency:'Vietnam Airlines',reference_only:true,flight_options_available:false,
    main_price:price,minimum_price:price,legs,leg_errors:legErrors,cells:trackingMode(query)==='roundtrip'?[{depart:query.departureDate,return:query.returnDate,state:price===null?'unknown':'available',price}]:[],
    source_pages:trackedLegs(query).map(l=>'https://www.vietnamairlines.com/vn/vi?'+new URLSearchParams({from:l.from,to:l.to,departureDate:l.date})),requests,duration_ms:Date.now()-started,response_bytes:bytes};
}
