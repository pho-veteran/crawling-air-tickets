import {sourcePage as flynowPage} from '../providers/flynow-core.mjs';
import {sourcePage as bestpricePage} from '../providers/vietjet-bestprice.mjs';
import {trackingMode,trackedLegs} from '../shared/tracking.mjs';
// Recreate searches from the current query, never reuse supplier session URLs.
export function bookingLinks(id,query,record){
  const single=trackingMode(query)!=='roundtrip',leg=trackedLegs(query)[0];
  if(id==='vna')return [{
    label:'Đặt vé VNA (điền sẵn tuyến/ngày; kiểm tra hành khách rồi bấm Tìm chuyến bay)',
    url:'https://www.vietnamairlines.com/vn/vi?'+new URLSearchParams({
      from:leg.from,to:leg.to,departureDate:leg.date,...(single?{}:{returnDate:query.returnDate})})
  },...(record?.agency==='Flynow'?[{label:'Tìm cả hành trình trên Flynow (có phí đại lý; kiểm tra form tuyến/ngày)',url:flynowPage(query)}]:[]),
  ...(record?.price_is_estimate?[{label:'Tìm vé trên BestPrice',url:'https://www.bestprice.vn/ve-may-bay'},{label:'Tìm vé trên ABAY',url:'https://www.abay.vn/'}]:[])];
  if(id!=='vietjet')return [];
  return [
    {label:single?'Tìm vé một chiều trên Vietjet':'Tìm cả hành trình trên Vietjet',url:'https://www.vietjetair.com/vi/?'+new URLSearchParams({
      departAirport:leg.from,arrivalAirport:leg.to,currency:'VND',
      departDate:leg.date,...(single?{}:{returnDate:query.returnDate}),tripType:single?'oneWay':'roundTrip',adultCount:query.adults,languageCode:'vi'})},
    ...trackedLegs(query).map(l=>({label:'Tìm vé trên BestPrice (có phí đại lý)',url:bestpricePage(l,query.adults)}))
  ];
}
export const bookingText=(id,query,record)=>bookingLinks(id,query,record).map(({label,url})=>'🔗 '+label+':\n'+url).join('\n\n');
export function flightHint(quote){
  if(!quote?.flight_number)return '';
  const time=typeof quote.departure==='string'?quote.departure.slice(11,16):'';
  return [quote.flight_number,time,quote.fare_family].filter(Boolean).join(' · ');
}
export const isSeparateTickets=record=>['sum-of-oneway-airline-fares-excluding-agency-fee','temporary-agency-adjusted-estimate'].includes(record?.price_basis);
export function priceNote(id,record){
  if(record?.reference_only)return 'ℹ️ Giá lịch chính thức Vietnam Airlines gồm thuế/phí; API không trả giờ bay hoặc phân loại bay thẳng/nối chuyến. Chưa giữ chỗ.';
  if(record?.price_is_estimate)return 'ℹ️ Giá ước tính từ BestPrice/ABAY, đã điều chỉnh tạm theo chênh lệch đối chiếu. Giá thanh toán có thể khác; chưa giữ chỗ.';
  return record?.agency==='Flynow'||record?.agency==='BestPrice'?'ℹ️ '+(id==='vna'?'Vietnam Airlines':'Vietjet')+' qua '+record.agency+': gồm thuế/phí hãng; đã loại phí dịch vụ đại lý theo báo giá, chưa giữ chỗ.':'ℹ️ Gồm thuế theo nguồn; giá trọn hành trình được báo cùng lượt, chưa giữ chỗ.';
}
export const isConnecting=flight=>flight?.segments?.length>1||flight?.stops>0;
export function connectingSection(quote,label){
  const best=new Map();
  for(const f of quote?.flights||[]){
    if(!isConnecting(f)||!Number.isSafeInteger(f.price)||f.price<=0||!f.flight_number||
      !f.departure?.startsWith(quote.date+'T')||f.date!==quote.date)continue;
    const key=f.flight_number+'|'+f.departure;
    if(!best.has(key)||f.price<best.get(key).price)best.set(key,f);
  }
  if(!best.size)return [];
  const lines=['','🔀 Nối chuyến · '+label];
  for(const f of [...best.values()].sort((a,b)=>a.departure.localeCompare(b.departure)||a.flight_number.localeCompare(b.flight_number))){
    const arrival=f.arrival?.slice(11,16)||'?',arrivalDay=f.arrival?.slice(0,10);
    const dayNote=arrivalDay&&arrivalDay!==quote.date?' ('+arrivalDay.split('-').reverse().join('/')+')':'';
    const duration=Number.isSafeInteger(f.total_duration_minutes)?' · '+Math.floor(f.total_duration_minutes/60)+'h'+String(f.total_duration_minutes%60).padStart(2,'0'):'';
    lines.push('• '+f.flight_number+' · '+f.departure.slice(11,16)+' → '+arrival+dayNote+' · '+(f.fare_family||'hạng chưa rõ')+duration+' · '+new Intl.NumberFormat('vi-VN').format(f.price)+'đ');
    for(const s of f.segments||[])lines.push('  '+s.from+' → '+s.to+' · '+s.flight_number+' · '+s.departure.slice(11,16)+' → '+s.arrival.slice(11,16));
  }
  return lines;
}
export function agencyPrices(record,leg,date){
  const money=n=>new Intl.NumberFormat('vi-VN').format(n)+'đ';
  return (record?.agency_quotes||[]).filter(q=>q.leg===leg&&q.date===date).map(q=>{
    if(q.status==='empty')return '• '+q.agency+': không có báo giá phù hợp.';
    if(q.status!=='ok')return '• '+q.agency+': chưa cập nhật được.';
    const offset=q.adjustment_vnd,adjustment=offset?' '+(offset<0?'−':'+')+money(Math.abs(offset)):'';
    const at=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(q.observed_at));
    return '• '+q.agency+': '+money(q.raw_price)+adjustment+' → '+money(q.price)+' (ước tính; '+at+')'+
      (q.agency_fee>0?' · đã bỏ phí đại lý '+money(q.agency_fee):'');
  });
}
