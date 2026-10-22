import {queryId} from './vna-core.mjs';
import {trackedLegs,trackingMode} from '../shared/tracking.mjs';

export const SOURCE='vna-agency-estimates-v1';
export const BASIS='temporary-agency-adjusted-estimate';
// User-approved temporary offsets from the 22 October official comparison.
// Do not extrapolate the return-leg calibration to other routes/dates.
export const CALIBRATION={from:'VCL',to:'SGN',date:'2027-02-13',adults:1,bestprice:-819,abay:181};
const names={bestprice:'BestPrice',abay:'ABAY'},months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const decode=s=>String(s).replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n)))
  .replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#039;',"'").replaceAll('&nbsp;',' ');
const text=s=>decode(String(s).replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export const attr=(tag,key)=>{const m=String(tag||'').match(new RegExp('(?:^|\\s)'+key+'=(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'));return decode(m?.[1]??m?.[2]??m?.[3]??'');};
const number=(n,label)=>{if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid agency amount: '+label);return n;};
const money=s=>{if(!/^\d{1,3}(?:,\d{3})+$|^\d+$/.test(String(s)))throw new Error('Invalid ABAY amount');return number(Number(String(s).replaceAll(',','')),'ABAY');};
const dateTime=(value,date)=>{
  if(!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value||'')||value.slice(0,10)!==date||!Number.isFinite(Date.parse(value.replace(' ','T')+'+07:00')))throw new Error('Agency flight date mismatch');
  return value.replace(' ','T');
};
export function adjustedQuote(id,leg,fields,observedAt=new Date().toISOString()){
  const offset=leg.from===CALIBRATION.from&&leg.to===CALIBRATION.to&&leg.date===CALIBRATION.date?CALIBRATION[id]:0;
  const price=fields.raw_price+offset;if(!Number.isSafeInteger(price)||price<=0)throw new Error('Invalid adjusted agency price');
  return {...fields,date:leg.date,price,agency:names[id],adjustment_vnd:offset,price_is_estimate:true,observed_at:observedAt,time_zone:'Asia/Ho_Chi_Minh'};
}
function session(fetchImpl){
  let requests=0,bytes=0;const deadline=Date.now()+45000,jar=new Map();
  return {get requests(){return requests;},get bytes(){return bytes;},async read(url,options={}){
    if(++requests>8)throw new Error('Agency request budget exceeded');
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('Agency search deadline exceeded');
    const response=await fetchImpl(String(url),{...options,redirect:'manual',signal:AbortSignal.timeout(Math.min(25000,remaining)),headers:{...options.headers,...(jar.size?{cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{})}});
    for(const c of response.headers.getSetCookie?.()||[]){const p=c.split(';')[0],i=p.indexOf('=');if(i>0)jar.set(p.slice(0,i),p.slice(i+1));}
    if(!response.ok&&![301,302,303].includes(response.status)){await response.body?.cancel();throw new Error('Agency HTTP '+response.status);}
    const chunks=[];let size=0;
    for await(const c of response.body||[]){size+=c.length;if(size>1024*1024){await response.body?.cancel().catch(()=>{});throw new Error('Agency response exceeds 1 MiB');}chunks.push(c);}
    bytes+=size;return {response,body:Buffer.concat(chunks).toString('utf8')};
  }};
}
const city={VCL:'Chu Lai (VCL)',SGN:'Ho Chi Minh (SGN)'};
export function bestpriceUrl(leg){return 'https://www.bestprice.vn/ve-may-bay/tim-kiem-ve?'+new URLSearchParams({From:city[leg.from],To:city[leg.to],Depart:leg.date.split('-').reverse().join('/'),Return:'',ADT:'1',CHD:'0',INF:'0',is_search_cheapest:'0',Airline:'VN'});}
export function parseBestprice(data,leg,observedAt){
  const d=data.search_data;if(!d||!Array.isArray(d.flight_data))throw new Error('BestPrice search schema changed');
  const flights=[];
  for(const f of d.flight_data){
    if(f.Airlines!=='VN'||f.Stop!==0)continue;
    if(f.From!==leg.from||f.To!==leg.to||!/^VN-?\d+$/.test(f.FlightNumber||''))throw new Error('BestPrice itinerary mismatch');
    const departure=dateTime(f.DateFrom,leg.date),arrival=dateTime(f.DateTo,leg.date);
    if(arrival<=departure||!Array.isArray(f.PriceInfo))throw new Error('BestPrice flight schema changed');
    for(const p of f.PriceInfo){
      if(!Number.isInteger(p.Seat)||p.Seat<1)continue;
      const base=number(p.ADT_Fare,'fare'),tax=number(p.ADT_Tax,'tax'),fee=number(p.BP_Fee,'fee');
      if(!Number.isSafeInteger(base+tax+fee))throw new Error('BestPrice total exceeds safe amount');
      if(number(p.BP_Discount,'discount')||number(p.BP_Discount_Total,'discount total')||!base)throw new Error('BestPrice discounted/empty fare unsupported');
      flights.push(adjustedQuote('bestprice',leg,{raw_price:base+tax,base_fare:base,airline_taxes:tax,agency_fee:fee,ota_price:base+tax+fee,
        flight_number:f.FlightNumber.replace('-',''),departure,arrival,booking_class:p.Class,fare_basis:null,fare_family:p.Class==='J'?'Thương Gia Linh Hoạt':p.Class,
        baggage:p.AllowanceBaggage||null,hand_baggage:p.HandBaggage||null},observedAt));
    }
  }
  return flights;
}
export async function crawlBestprice(leg,{fetchImpl=fetch}={}){
  const s=session(fetchImpl),base='https://www.bestprice.vn';
  try{
    const {body:h}=await s.read(bestpriceUrl(leg));
    const inputs=[...h.matchAll(/<input\b[^>]*>/gi)].map(m=>m[0]);
    const value=id=>attr(inputs.find(t=>attr(t,'id')===id),'value');
    const sid=value('sid'),search=value('search_flight_url');if(!sid||!search)throw new Error('BestPrice search form unavailable');
    const start=await s.read(base+'/get-vnisc-sid.html?sid='+encodeURIComponent(sid)+'&'+search);
    const vnisc=JSON.parse(start.body).vnisc_sid;if(typeof vnisc!=='string'||!vnisc)throw new Error('BestPrice search unavailable');
    let previous='',time='';
    for(let i=0;i<3;i++){
      const params=new URLSearchParams(search);
      for(const [k,v] of Object.entries({sid,vnisc_sid:vnisc,previous_flights:previous,flight_type:'depart',previous_airline:'',time_first_call:time,airline_search:'VN'}))params.set(k,v);
      const {body}=await s.read(base+'/ajax-search-flight-bp?'+params),data=JSON.parse(body),flights=parseBestprice(data,leg);
      if(flights.length)return {flights,requests:s.requests,bytes:s.bytes};
      if(data.search_status!=='CONTINUE')break;
      previous=data.search_data?.previous_flights||'';time=data.search_data?.time_first_call||'';
      if(i<2)await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('BestPrice has no matching priced VNA flight');
  }catch(e){throw Object.assign(new Error('BestPrice: '+safeError(e)),{requests:s.requests});}
}
const abayBase='https://www.abay.vn/';
const safeAbay=url=>{const u=new URL(url,abayBase);if(u.origin!==new URL(abayBase).origin||u.username||u.password)throw new Error('ABAY redirect host rejected');return u;};
export function parseAbayFlight(f,detail,leg,observedAt){
  if(f.E!=='VN'||!/^VN\d+$/.test(f.F||'')||!/^\d{2}:\d{2}$/.test(f.G||'')||!/^\d{2}:\d{2}$/.test(f.H||''))throw new Error('ABAY flight schema changed');
  const parts=leg.date.split('-'),wire=parts[2]+months[Number(parts[1])-1]+parts[0];
  if(!f.N?.startsWith(leg.from+'-'+leg.to+'-'+wire+'-'+f.G+'|'+f.F+'-'))throw new Error('ABAY itinerary mismatch');
  const fare=f.N.match(/,([A-Z0-9]+)-[A-Z0-9]+-([A-Z0-9]+)-OperateAirlineVN-SeatRemain(\d+)-(\d+)/);
  if(!fare)throw new Error('ABAY operating airline/fare schema changed');
  if(Number(fare[3])<1||Number(fare[4])!==0)return null;
  if(f.J!==f.L)throw new Error('ABAY discount unsupported');
  const table=detail.match(/<table\b[^>]*class=["']?price-break\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if(!table)throw new Error('ABAY fare breakdown unavailable');
  const cells=[...table.matchAll(/<td\b([^>]*)>([\s\S]*?)(?=<td\b|<tr\b|<\/table|$)/gi)].filter(m=>/\bpax\b/.test(attr(m[1],'class'))).map(m=>text(m[2]));
  if(cells.length!==5||cells[1]!=='1'||!cells[0].includes('Người lớn'))throw new Error('ABAY passenger breakdown mismatch');
  const amount=c=>money(c.replace(/\s*VNĐ\s*$/,''));
  const base=amount(cells[2]),tax=amount(cells[3]),raw=amount(cells[4]);
  if(!base||base!==money(f.L)||base+tax!==raw)throw new Error('ABAY total mismatch');
  const departure=dateTime(leg.date+'T'+f.G+':00',leg.date),arrival=dateTime(leg.date+'T'+f.H+':00',leg.date);
  if(arrival<=departure)throw new Error('ABAY arrival mismatch');
  return adjustedQuote('abay',leg,{raw_price:raw,base_fare:base,airline_taxes:tax,agency_fee:null,ota_price:raw,
    flight_number:f.F,departure,arrival,booking_class:fare[1],fare_basis:fare[2],fare_family:f.O||fare[1],baggage:null,hand_baggage:null},observedAt);
}
export async function crawlAbay(leg,{fetchImpl=fetch}={}){
  const s=session(fetchImpl);
  try{
    const {body:html}=await s.read(abayBase),form=new URLSearchParams(),inputs=[...html.matchAll(/<input\b[^>]*>/gi)].map(m=>m[0]);
    for(const tag of inputs){const type=attr(tag,'type'),name=attr(tag,'name');if(name&&!['submit','image','checkbox','radio'].includes(type))form.set(name,attr(tag,'value'));}
    const prefix='ctl00$cphMain$ctl00$usrSearchFormD2$',date=leg.date.split('-').reverse().join('-'),places={VCL:'Tam Kỳ',SGN:'Tp Hồ Chí Minh'};
    if(!form.get('__VIEWSTATE'))throw new Error('ABAY search form unavailable');
    for(const [name,value] of Object.entries({hdfstartplace:leg.from,hdfendplace:leg.to,hdfDepartureDate:date,hdfReturnDate:'','txt-date-departure':date.replaceAll('-','/'),'txt-date-return':'',
      [prefix+'txtFrom']:places[leg.from],[prefix+'txtTo']:places[leg.to],[prefix+'txtDepDate']:date,[prefix+'txtRetDate']:'',[prefix+'cboAdult']:'1',[prefix+'cboChild']:'0',[prefix+'cboInfant']:'0',
      [prefix+'btnSearch']:attr(inputs.find(t=>attr(t,'name')===prefix+'btnSearch'),'value')}))form.set(name,value);
    const start=await s.read(abayBase,{method:'POST',body:form});
    if(![302,303].includes(start.response.status)||!start.response.headers.get('location'))throw new Error('ABAY search redirect unavailable');
    const resultUrl=safeAbay(start.response.headers.get('location'));
    const {body:results,response}=await s.read(resultUrl,{headers:{referer:abayBase}});if(!response.ok)throw new Error('ABAY result unavailable');
    const info=results.match(/<div\b[^>]*\bid=["']?sInfo["']?[^>]*>([^<]+)</i)?.[1];
    const parts=leg.date.split('-'),wire=parts[2]+months[Number(parts[1])-1]+parts[0];
    if(info!==leg.from+'-'+leg.to+'-1-0-0-'+wire+'-')throw new Error('ABAY search itinerary mismatch');
    const params=new URLSearchParams({input:info,sortby:'abay-suggest',filterbyairline:'VN',defaultSort:'1',IsRewriteFare:'0',display:'base',edition:'2',lang:'VN',cookieAll:'{}',waytype:'OutBound',isAllowSearchReal:'0'});
    const {body}=await s.read(abayBase+'_WEB/ResultDom2024/ResultDomAjax.aspx/GetFlights?'+params,{method:'POST',headers:{'content-type':'application/json',referer:String(resultUrl)},body:'{}'});
    const payload=JSON.parse(body),data=typeof payload.d==='string'?JSON.parse(payload.d):payload.d;
    if(!Array.isArray(data?.D))throw new Error('ABAY search schema changed');
    const candidates=data.D.filter(f=>f.E==='VN'&&f.T);if(candidates.length>4)throw new Error('ABAY flight detail budget exceeded');
    const flights=[];
    for(const f of candidates){const u=safeAbay(f.T);if(u.pathname.toLowerCase()!=='/_web/resultdom2024/usrdesktop/flightdetail.aspx')throw new Error('ABAY detail path rejected');
      const {body:detail}=await s.read(u,{headers:{referer:String(resultUrl)}}),quote=parseAbayFlight(f,detail,leg);if(quote)flights.push(quote);}
    if(!flights.length)throw new Error('ABAY has no matching priced VNA flight');
    return {flights,requests:s.requests,bytes:s.bytes};
  }catch(e){throw Object.assign(new Error('ABAY: '+safeError(e)),{requests:s.requests});}
}
// Provider error text/URLs can contain opaque sessions. Persist only our own messages.
function safeError(e){return /^(?:Agency |BestPrice[ :]|ABAY[ :]|Invalid |The operation was aborted)/.test(e.message||'')?e.message.slice(0,180):'search unavailable or response schema changed ('+(/^[A-Za-z]+$/.test(e.name||'')?e.name:'Error')+')';}
export async function crawl(query,{fetchImpl=fetch,bestpriceImpl,abayFetchImpl}={}){
  if(query.adults!==1||query.origin===query.destination||![query.origin,query.destination].every(c=>c in city))throw new Error('VNA agency estimates support SGN/VCL and one adult only');
  const began=Date.now(),agencyQuotes=[],legs={},legErrors={};let requests=0,bytes=0;
  for(const leg of trackedLegs(query)){
    const results=await Promise.all([['bestprice',bestpriceImpl||crawlBestprice],['abay',crawlAbay]].map(async([id,run])=>{
      try{const r=await run(leg,{fetchImpl:id==='abay'?(abayFetchImpl||fetchImpl):fetchImpl});requests+=r.requests;bytes+=r.bytes;const flights=r.flights.sort((a,b)=>a.price-b.price||a.departure.localeCompare(b.departure));
        return {agency:names[id],leg:leg.leg,date:leg.date,status:'ok',...flights[0],flights};
      }catch(e){requests+=e.requests||0;return {agency:names[id],leg:leg.leg,date:leg.date,status:'error',error:safeError(e)};}
    }));
    agencyQuotes.push(...results);const flights=results.flatMap(r=>r.flights||[]).sort((a,b)=>a.price-b.price||a.departure.localeCompare(b.departure)||a.agency.localeCompare(b.agency));
    legs[leg.leg]=[flights.length?{...flights[0],flights}:{date:leg.date,price:null,flights:[]}];
    if(results.some(r=>r.status==='error'))legErrors[leg.leg]='One or more agency searches failed';
  }
  if(!Object.values(legs).some(([q])=>q.price>0))throw Object.assign(new Error('VNA: BestPrice and ABAY searches unavailable; no current estimate'),{requests,agency_quotes:agencyQuotes});
  agencyQuotes.sort((a,b)=>a.leg.localeCompare(b.leg)||a.agency.localeCompare(b.agency));
  const prices=trackedLegs(query).map(l=>legs[l.leg][0].price),price=prices.some(p=>!p)?null:prices.reduce((a,b)=>a+b,0);
  const observedAt=trackedLegs(query).map(l=>legs[l.leg][0].observed_at).filter(Boolean).sort()[0]||new Date().toISOString();
  return {schema:1,source:SOURCE,query_id:queryId(query,SOURCE),query,observed_at:observedAt,status:Object.keys(legErrors).length||price===null?'partial':'ok',currency:'VND',
    taxes_included:true,scope:'selected-dates',price_basis:BASIS,price_is_estimate:true,agency:'BestPrice + ABAY',adjustment_method:'User-approved temporary per-leg agency offsets; not a guaranteed official VNA quote',
    main_price:price,minimum_price:price,legs,leg_errors:legErrors,agency_quotes:agencyQuotes,source_pages:['https://www.bestprice.vn/ve-may-bay','https://www.abay.vn/'],
    cells:trackingMode(query)==='roundtrip'?[{depart:query.departureDate,return:query.returnDate,state:price===null?'unknown':'available',price}]:[],requests,duration_ms:Date.now()-began,response_bytes:bytes};
}
