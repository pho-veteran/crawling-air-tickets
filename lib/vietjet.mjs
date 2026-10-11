import {dateRange,queryId} from './api.mjs';

export const SOURCE='vietjet-public-calendar-v1';
const SLUGS={SGN:'tp-ho-chi-minh',VCL:'chu-lai'};
const CONTENT='https://vja-ui.useleadr.com';
export function pagePath(from,to) {
  if(!SLUGS[from]||!SLUGS[to]) throw new Error('Vietjet: hiện hỗ trợ SGN ⇄ VCL. Chưa xác minh trang lịch giá cho đường bay khác.');
  return '/vi/ve-may-bay/ve-may-bay-'+SLUGS[from]+'-di-'+SLUGS[to];
}
export function parseCalendar(html,from,to,dates) {
  // Parse only the dated price-calendar cards, not promotions or unrelated fares.
  if(!html.includes('Giá vé chỉ áp dụng cho chuyến bay một chiều'))throw new Error('Vietjet: thiếu mô tả nguồn xác nhận giá một chiều.');
  const result=new Map();let calendarCards=0;
  const pattern=/<div\b([^>]*\bdata-startdate="[^"]+"[^>]*)>([\s\S]*?)<div class="time-calendar">/g;
  for(const match of html.matchAll(pattern)) {
    const attrs=Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
    if(!attrs.class?.split(/\s+/).includes('price-calendar'))continue;
    if(attrs['data-origin']!==from||attrs['data-destination']!==to)continue;
    calendarCards++;
    const date=attrs['data-startdate'];if(!dates.includes(date))continue;
    // triptype is the booking modal's search mode; the page describes all displayed fares as one-way.
    if(attrs['data-currency']!=='VND'||!['oneway','roundTrip'].includes(attrs['data-triptype']))throw new Error('Vietjet: lịch giá đổi tiền tệ hoặc loại hành trình.');
    const parts=match[2].match(/<span class="price-bold">([\s\S]*?)<\/span><span class="price-sm">([\s\S]*?)<\/span>/);
    if(!parts)throw new Error('Vietjet: cấu trúc giá trong lịch đã thay đổi.');
    const text=parts.slice(1).join(' ').replace(/<[^>]+>/g,'').trim();
    if(!/^[\d\s]+VND$/.test(text))throw new Error('Vietjet: không đọc được số tiền VND.');
    const price=Number(text.replace(/\s|VND/g,''));
    if(!Number.isSafeInteger(price)||price<=0)throw new Error('Vietjet: số tiền không hợp lệ.');
    const fare=(attrs['data-faretype']||'').slice(0,50);
    if(result.has(date)&&result.get(date).price!==price)throw new Error('Vietjet: có nhiều giá lịch mâu thuẫn cho cùng ngày.');
    result.set(date,{date,price,fare_family:fare||null,search_type:attrs['data-triptype']});
  }
  if(!calendarCards)throw new Error('Vietjet: không tìm thấy lịch giá đúng đường bay; không suy diễn là hết vé.');
  return dates.map(date=>result.get(date)||{date,price:null,fare_family:null});
}
async function getCalendar(from,to,dates,fetchImpl) {
  const pathname=pagePath(from,to);
  // This public content endpoint is used by the official site's fare-page component.
  const response=await fetchImpl(CONTENT+pathname,{headers:{'Content-Type':'text/html','Leadr-Host':'www.vietjetair.com'},
    signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw new Error('Vietjet: HTTP '+response.status+' khi đọc lịch công khai. Đã dừng, không retry.');
  if(!/text\/html/i.test(response.headers.get('content-type')||''))throw new Error('Vietjet: nguồn lịch không trả HTML.');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Vietjet: response vượt 2 MiB.');chunks.push(chunk);}
  const observedAt=new Date().toISOString();
  return {dates:parseCalendar(Buffer.concat(chunks).toString('utf8'),from,to,dates).map(d=>({...d,observed_at:observedAt})),bytes,
    page:'https://www.vietjetair.com'+pathname};
}
export async function crawl(query,{fetchImpl=fetch}={}) {
  if(query.adults!==1)throw new Error('Vietjet: nguồn lịch tham khảo hiện chỉ hỗ trợ 1 người lớn; không nhân giá để suy diễn tồn chỗ.');
  let requests=0;const start=Date.now();
  try {
    requests++;const out=await getCalendar(query.origin,query.destination,dateRange(query.departureDate),fetchImpl);
    requests++;const back=await getCalendar(query.destination,query.origin,dateRange(query.returnDate),fetchImpl);
    const cells=out.dates.flatMap(d=>back.dates.map(r=>({depart:d.date,return:r.date,
      state:d.price===null||r.price===null?'unknown':'available',price:d.price===null||r.price===null?null:d.price+r.price})));
    const prices=cells.filter(c=>c.price!==null).map(c=>c.price);
    return {schema:1,source:SOURCE,query_id:queryId(query,SOURCE),query,observed_at:new Date().toISOString(),
      status:prices.length===49?'ok':'partial',currency:'VND',price_basis:'sum-of-public-oneway-quotes',
      main_price:cells.find(c=>c.depart===query.departureDate&&c.return===query.returnDate)?.price??null,
      minimum_price:prices.length?Math.min(...prices):null,cells,legs:{outbound:out.dates,inbound:back.dates},
      source_pages:[out.page,back.page],source_window_hours:24,taxes_included:null,
      requests,duration_ms:Date.now()-start,response_bytes:out.bytes+back.bytes};
  }catch(error){error.requests=requests;throw error;}
}
