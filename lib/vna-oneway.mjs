export const ENDPOINT='https://integration-middleware-website.vietnamairlines.com/api/v1/public/booking/air-best-price';
export function oneWayRequest(from,to,dates){
  return {route:{originLocationCode:from,destinationLocationCode:to,departureDateTime:dates[0]},tripDetails:{rangeOfDeparture:7},location:'VN'};
}
export function normalizeOneWay(payload,dates,observedAt=new Date().toISOString()){
  if(payload.success!==true||!Array.isArray(payload.data?.prices))throw new Error('VNA một chiều: thiếu dữ liệu prices.');
  if(payload.data.dictionaries?.currency?.VND?.decimalPlaces!==0)throw new Error('VNA một chiều: cần VND với decimalPlaces=0.');
  const map=new Map();
  const number=v=>/^\d+$/.test(String(v))&&Number.isSafeInteger(Number(v))?Number(v):NaN;
  for(const entry of payload.data.prices){
    if(entry.returnDate)throw new Error('VNA một chiều: nguồn trả giá khứ hồi, không dùng làm giá riêng.');
    if(!dates.includes(entry.departureDate))continue;
    if(!Array.isArray(entry.price)||entry.price.length!==1)throw new Error('VNA một chiều: cấu trúc price thay đổi.');
    const p=entry.price[0],price=number(p.total),base=number(p.base),taxes=number(p.totalTaxes);
    if(p.currencyCode!=='VND'||!(price>0)||!(base>=0)||!(taxes>=0)||base+taxes!==price)throw new Error('VNA một chiều: giá/thuế/tiền tệ không hợp lệ.');
    if(map.has(entry.departureDate))throw new Error('VNA một chiều: trùng ngày.');
    map.set(entry.departureDate,{date:entry.departureDate,price,base,taxes,fare_family:null,observed_at:observedAt});
  }
  return dates.map(date=>map.get(date)||{date,price:null,base:null,taxes:null,fare_family:null,observed_at:observedAt});
}
export async function fetchOneWay(from,to,dates,fetchImpl=fetch){
  const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(oneWayRequest(from,to,dates)),signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw new Error('VNA một chiều: HTTP '+response.status+'. Không retry.');
  if(!/json/i.test(response.headers.get('content-type')||''))throw new Error('VNA một chiều: nguồn không trả JSON.');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('VNA một chiều: response vượt 2 MiB.');chunks.push(chunk);}
  return {dates:normalizeOneWay(JSON.parse(Buffer.concat(chunks).toString('utf8')),dates),bytes};
}
