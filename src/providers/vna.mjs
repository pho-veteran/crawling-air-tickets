import {createHash} from 'node:crypto';
import {configureTLS} from '../shared/tls.mjs';
import {fetchOneWay,ENDPOINT as ONEWAY_ENDPOINT} from './vna-oneway.mjs';

export const SOURCE='vna-fare-matrix-v1';
export const ENDPOINT='https://integration-middleware-website.vietnamairlines.com/api/v1/public/flight/fare-matrix';
export const shiftDate=(date,days)=>new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10);
export const dateRange=date=>Array.from({length:7},(_,i)=>shiftDate(date,i-3));
export function queryFrom(config) {
  for(const key of ['departureDate','returnDate']) {
    const date=config[key];
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'') || !Number.isFinite(Date.parse(date)) || shiftDate(date,0)!==date)
      throw new Error(`config.${key}: cần ngày YYYY-MM-DD hợp lệ.`);
  }
  if(config.returnDate<=config.departureDate) throw new Error('Ngày về phải sau ngày đi.');
  for(const key of ['origin','destination']) if(!/^[A-Z]{3}$/.test(config[key]||'')) throw new Error(`config.${key}: cần mã sân bay 3 chữ hoa.`);
  if(config.origin===config.destination) throw new Error('Điểm đi và điểm đến phải khác nhau.');
  if(!Number.isInteger(config.adults)||config.adults<1||config.adults>9) throw new Error('adults phải từ 1 đến 9.');
  return {origin:config.origin,destination:config.destination,departureDate:config.departureDate,
    returnDate:config.returnDate,adults:config.adults,nearbyDays:3,countryCode:'vn',currency:'VND'};
}
export const queryId=(query,source=SOURCE)=>createHash('sha256').update(source+JSON.stringify(query)).digest('hex').slice(0,16);
export function requestFrom(query) {
  return {departureDate:query.departureDate,returnDate:query.returnDate,
    originLocationCode:query.origin,destinationLocationCode:query.destination,
    flexibility:3,commercialFareFamilies:['WEB'],travelers:Array.from({length:query.adults},()=>({passengerTypeCode:'ADT'})),
    totalCol:7,countryCode:'vn'};
}
export function normalize(payload,query,observedAt=new Date().toISOString()) {
  if(payload.success!==true || !payload.data) throw new Error('API không trả dữ liệu thành công.');
  const d=payload.data,departures=dateRange(query.departureDate),returns=dateRange(query.returnDate);
  if(d.currencyCode!=='VND'||d.dictionaries?.currency?.VND?.decimalPlaces!==0) throw new Error('API_CURRENCY_CHANGED: cần VND với decimalPlaces=0.');
  if(JSON.stringify(d.departureDates)!==JSON.stringify(departures)||JSON.stringify(d.returnDates)!==JSON.stringify(returns))
    throw new Error('API_DATE_MISMATCH: ma trận không khớp khoảng ngày yêu cầu.');
  if(!Array.isArray(d.rows)) throw new Error('API_SCHEMA_CHANGED: thiếu rows.');
  const map=new Map();
  for(const row of d.rows) {
    if(!Array.isArray(row.cells)) throw new Error('API_SCHEMA_CHANGED: thiếu cells.');
    for(const c of row.cells) {
      if(c.departureDate!==row.departureDate||!departures.includes(c.departureDate)||!returns.includes(c.returnDate)) throw new Error('API_DATE_MISMATCH: ô sai ngày.');
      const key=c.departureDate+'|'+c.returnDate;
      if(map.has(key)) throw new Error('API_SCHEMA_CHANGED: trùng ô.');
      if(c.currencyCode && c.currencyCode!=='VND') throw new Error('API_CURRENCY_CHANGED: ô không phải VND.');
      let state='unknown',price=null;
      if(c.disabled===true) state='disabled';
      else if(c.soldOut===true || c.available===false) state='unavailable';
      else if(c.available===true) {
        if(!Number.isSafeInteger(c.totalPrice)||c.totalPrice<=0) throw new Error('API_SCHEMA_CHANGED: giá không hợp lệ.');
        state='available';price=c.totalPrice;
      }
      map.set(key,{depart:c.departureDate,return:c.returnDate,state,price});
    }
  }
  const cells=departures.flatMap(depart=>returns.map(back=>map.get(depart+'|'+back)||{depart,return:back,state:'unknown',price:null}));
  const main=cells.find(c=>c.depart===query.departureDate&&c.return===query.returnDate);
  const available=cells.filter(c=>c.price!==null);
  return {schema:1,source:SOURCE,query_id:queryId(query),query,observed_at:observedAt,
    status:cells.some(c=>c.state==='unknown')?'partial':'ok',currency:'VND',
    main_price:main?.price??null,minimum_price:available.length?Math.min(...available.map(c=>c.price)):null,cells};
}
export async function crawl(query,{fetchImpl=fetch}={}) {
  configureTLS();
  const start=Date.now();
  const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(requestFrom(query)),signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok) throw new Error(`HTTP ${response.status}${response.headers.get('retry-after')?'; Retry-After: '+response.headers.get('retry-after'):''}. Đã dừng; không thử lại tự động.`);
  if(!/json/i.test(response.headers.get('content-type')||'')) throw new Error('API không trả JSON.');
  const chunks=[];let length=0;
  for await(const chunk of response.body) {
    length+=chunk.length;if(length>2*1024*1024) throw new Error('API response vượt 2 MiB.');chunks.push(chunk);
  }
  const snapshot=normalize(JSON.parse(Buffer.concat(chunks).toString('utf8')),query);
  snapshot.legs={outbound:[],inbound:[]};snapshot.leg_errors={};
  snapshot.legs_source='vna-air-best-price-oneway-v1';snapshot.legs_price_basis='independent-oneway-reference';
  snapshot.legs_passengers=1;snapshot.legs_endpoint=ONEWAY_ENDPOINT;
  let requests=1;
  for(const [leg,from,to,date] of [['outbound',query.origin,query.destination,query.departureDate],['inbound',query.destination,query.origin,query.returnDate]]){
    if(query.adults!==1){snapshot.leg_errors[leg]='Nguồn giá lịch một chiều chỉ xác minh cho 1 người lớn.';continue;}
    try{requests++;const result=await fetchOneWay(from,to,dateRange(date),fetchImpl);snapshot.legs[leg]=result.dates;length+=result.bytes;}
    catch(e){snapshot.leg_errors[leg]=String(e.message).slice(0,250);}
  }
  snapshot.legs_status=Object.keys(snapshot.leg_errors).length?'error':Object.values(snapshot.legs).some(leg=>leg.some(d=>d.price===null))?'partial':'ok';
  if(snapshot.legs_status!=='ok'&&snapshot.status==='ok')snapshot.status='partial';
  return {...snapshot,requests,http_status:response.status,duration_ms:Date.now()-start,response_bytes:length};
}
