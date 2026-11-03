import {SOURCE,BASIS,adjustedQuote} from '../providers/vna-agencies.mjs';
import {queryId} from '../providers/vna-core.mjs';
import {trackedLegs,trackingMode} from '../shared/tracking.mjs';
import {canonicalJson} from '../storage/d1.mjs';
import {FEED_MAX_AGE_MS} from './vna-agencies.mjs';

const integer=n=>Number.isSafeInteger(n)&&n>=0;
const cleanText=s=>typeof s==='string'?s.replace(/[\r\n\x00-\x1f]/g,' ').slice(0,120):null;
export function validateFeed(input,query,now=Date.now()){
  if(input?.source!==SOURCE||input.query_id!==queryId(query,SOURCE)||canonicalJson(input.query)!==canonicalJson(query)||input.currency!=='VND'||!Array.isArray(input.agency_quotes))throw new Error('Feed itinerary/source mismatch');
  const selected=trackedLegs(query),agencyQuotes=[],legs={},legErrors={};
  const timestamp=value=>{const t=Date.parse(value);if(!Number.isFinite(t)||t>now+60000||now-t>FEED_MAX_AGE_MS)throw new Error('Feed timestamp outside freshness window');return new Date(t).toISOString();};
  timestamp(input.observed_at);
  if(input.agency_quotes.length!==selected.length*2)throw new Error('Feed must report both agencies for every tracked leg');
  for(const leg of selected){
    const all=[];
    for(const [agency,id] of [['BestPrice','bestprice'],['ABAY','abay']]){
      const matches=input.agency_quotes.filter(q=>q.agency===agency&&q.leg===leg.leg&&q.date===leg.date);
      if(matches.length!==1)throw new Error('Feed duplicate/missing agency');
      const r=matches[0];
      if(r.status==='error'){agencyQuotes.push({agency,leg:leg.leg,date:leg.date,status:'error',error:'Agency search unavailable'});legErrors[leg.leg]='One or more agency searches failed';continue;}
      if(r.status!=='ok'||!Array.isArray(r.flights)||r.flights.length<1||r.flights.length>8)throw new Error('Feed flight list invalid');
      const flights=r.flights.map(f=>{
        if(f.agency!==agency||f.date!==leg.date||!/^VN\d+$/.test(f.flight_number||'')||
          !new RegExp('^'+leg.date+'T\\d{2}:\\d{2}:\\d{2}$').test(f.departure||'')||
          !new RegExp('^'+leg.date+'T\\d{2}:\\d{2}:\\d{2}$').test(f.arrival||'')||
          !Number.isFinite(Date.parse(f.departure+'+07:00'))||!Number.isFinite(Date.parse(f.arrival+'+07:00'))||f.arrival<=f.departure||
          ![f.base_fare,f.airline_taxes,f.raw_price,f.ota_price].every(integer)||!f.base_fare||f.base_fare+f.airline_taxes!==f.raw_price)
          throw new Error('Feed fare/flight invalid');
        if(id==='bestprice'&&(!integer(f.agency_fee)||f.ota_price!==f.raw_price+f.agency_fee)||id==='abay'&&(f.agency_fee!==null||f.ota_price!==f.raw_price))throw new Error('Feed agency fee mismatch');
        const quote=adjustedQuote(id,leg,{raw_price:f.raw_price,base_fare:f.base_fare,airline_taxes:f.airline_taxes,agency_fee:f.agency_fee,ota_price:f.ota_price,
          flight_number:f.flight_number,departure:f.departure,arrival:f.arrival,booking_class:cleanText(f.booking_class),fare_basis:cleanText(f.fare_basis),fare_family:cleanText(f.fare_family),baggage:cleanText(f.baggage),hand_baggage:cleanText(f.hand_baggage)},timestamp(f.observed_at));
        if(f.price!==quote.price||f.adjustment_vnd!==quote.adjustment_vnd)throw new Error('Feed adjustment mismatch');
        return quote;
      }).sort((a,b)=>a.price-b.price||a.departure.localeCompare(b.departure));
      all.push(...flights);agencyQuotes.push({agency,leg:leg.leg,date:leg.date,status:'ok',...flights[0],flights});
    }
    all.sort((a,b)=>a.price-b.price||a.departure.localeCompare(b.departure)||a.agency.localeCompare(b.agency));
    legs[leg.leg]=[all.length?{...all[0],flights:all}:{date:leg.date,price:null,flights:[]}];
  }
  if(!Object.values(legs).some(([q])=>q.price>0))throw new Error('Feed has no usable agency quote');
  const amounts=selected.map(l=>legs[l.leg][0].price),price=amounts.some(p=>p===null)?null:amounts.reduce((a,b)=>a+b,0);
  return {schema:1,source:SOURCE,query_id:queryId(query,SOURCE),query,observed_at:selected.map(l=>legs[l.leg][0].observed_at).filter(Boolean).sort()[0],
    status:Object.keys(legErrors).length||price===null?'partial':'ok',currency:'VND',taxes_included:true,scope:'selected-dates',price_basis:BASIS,price_is_estimate:true,
    agency:'BestPrice + ABAY',adjustment_method:'User-approved temporary per-leg agency offsets; not a guaranteed official VNA quote',
    main_price:price,minimum_price:price,legs,leg_errors:legErrors,agency_quotes:agencyQuotes,source_pages:['https://www.bestprice.vn/ve-may-bay','https://www.abay.vn/'],
    cells:trackingMode(query)==='roundtrip'?[{depart:query.departureDate,return:query.returnDate,state:price===null?'unknown':'available',price}]:[],
    requests:0,transport:'github-actions-feed',received_at:new Date(now).toISOString()};
}
