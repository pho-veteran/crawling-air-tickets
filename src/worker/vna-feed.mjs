import {SOURCE,BASIS} from '../providers/vna-official.mjs';
import {queryId} from '../providers/vna-core.mjs';
import {trackedLegs,trackingMode} from '../shared/tracking.mjs';
import {canonicalJson} from '../storage/d1.mjs';
import {FEED_MAX_AGE_MS} from './vna-feed-source.mjs';

const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function validateFeed(input,query,now=Date.now()){
  if(input?.source!==SOURCE||input.query_id!==queryId(query,SOURCE)||canonicalJson(input.query)!==canonicalJson(query)||input.currency!=='VND'||input.price_basis!==BASIS||input.reference_only!==true||!input.legs||typeof input.legs!=='object')throw new Error('Official feed itinerary/source mismatch');
  const timestamp=value=>{const t=Date.parse(value);if(!Number.isFinite(t)||t>now+60000||now-t>FEED_MAX_AGE_MS)throw new Error('Feed timestamp outside freshness window');return new Date(t).toISOString();};
  timestamp(input.observed_at);
  const selected=trackedLegs(query),legs={},legErrors={},observations=[];
  if(Object.keys(input.legs).some(key=>!selected.some(l=>l.leg===key)))throw new Error('Unexpected feed direction');
  for(const leg of selected){
    const quotes=input.legs[leg.leg];
    if(!quotes){if(!input.leg_errors?.[leg.leg])throw new Error('Missing official quote outcome');legErrors[leg.leg]='Official price search unavailable';continue;}
    if(!Array.isArray(quotes)||quotes.length!==1)throw new Error('Invalid official quote list');
    const q=quotes[0],observed_at=timestamp(q.observed_at);
    if(q.date!==leg.date||q.reference_only!==true||!Array.isArray(q.flights)||q.flights.length!==0)throw new Error('Official reference cannot claim flight inventory');
    if(q.price===null){if(q.base_fare!==null||q.airline_taxes!==null)throw new Error('Empty official quote contains amounts');}
    else if(![q.price,q.base_fare,q.airline_taxes].every(integer)||q.price<=0||q.base_fare+q.airline_taxes!==q.price)throw new Error('Official feed amount mismatch');
    legs[leg.leg]=[{date:leg.date,price:q.price,base_fare:q.base_fare,airline_taxes:q.airline_taxes,flights:[],observed_at,reference_only:true}];observations.push(observed_at);
  }
  if(!observations.length)throw new Error('No completed official price search');
  const values=selected.map(l=>legs[l.leg]?.[0].price),price=values.every(p=>Number.isSafeInteger(p)&&p>0)?values.reduce((a,b)=>a+b,0):null;
  return {schema:1,source:SOURCE,query_id:queryId(query,SOURCE),query,observed_at:observations.sort()[0],status:Object.keys(legErrors).length||price===null?'partial':'ok',currency:'VND',taxes_included:true,scope:'selected-dates',price_basis:BASIS,agency:'Vietnam Airlines',reference_only:true,flight_options_available:false,
    main_price:price,minimum_price:price,legs,leg_errors:legErrors,cells:trackingMode(query)==='roundtrip'?[{depart:query.departureDate,return:query.returnDate,state:price===null?'unknown':'available',price}]:[],source_pages:selected.map(l=>'https://www.vietnamairlines.com/vn/vi?'+new URLSearchParams({from:l.from,to:l.to,departureDate:l.date})),requests:0,transport:'github-actions-feed',received_at:new Date(now).toISOString()};
}
