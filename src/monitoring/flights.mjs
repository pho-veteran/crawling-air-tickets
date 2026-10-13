import {money,routeLine,when} from './messages.mjs';
import {bookingText,priceNote} from './booking-links.mjs';

function choices(quote,date,airline){
  const best=new Map();
  for(const f of quote?.flights||[]){
    if(f.date!==date||!f.departure?.startsWith(date+'T')||!f.flight_number?.startsWith(airline)||
      !Number.isSafeInteger(f.price)||f.price<=0)continue;
    const key=f.flight_number+'|'+f.departure;
    if(!best.has(key)||f.price<best.get(key).price)best.set(key,f);
  }
  return [...best.values()].sort((a,b)=>a.departure.localeCompare(b.departure)||a.flight_number.localeCompare(b.flight_number));
}
export function formatFlights({providers,query,now=Date.now(),pollMinutes=10}){
  const sections=['✈️ Giờ bay trong hai ngày bạn chọn',routeLine(query),'Giờ đi/đến là giờ Việt Nam (UTC+7). Giá thấp nhất có báo giá cho từng chuyến; chưa giữ chỗ.'];
  for(const p of providers){
    const history=p.history.filter(r=>Date.parse(r.observed_at)<=now),last=history.at(-1);
    const r=history.filter(r=>['ok','partial'].includes(r.status)).at(-1);
    const lines=[(p.id==='vna'?'🟦 ':'🟥 ')+p.name.toUpperCase()];
    if(!r){lines.push('⚠️ Chưa lấy được danh sách chuyến có giá của hãng này.');sections.push(lines.join('\n'));continue;}
    if(last?.status==='error'||now-Date.parse(r.observed_at)>(pollMinutes+5)*60000)
      lines.push('⚠️ GIÁ CŨ — lần cập nhật gần nhất '+when(r.observed_at));
    else if(r.status==='partial')lines.push('⚠️ Nguồn còn thiếu một phần; không suy diễn là hết vé.');
    for(const [leg,date,label,from,to] of [['outbound',query.departureDate,'🛫 Đi',query.origin,query.destination],['inbound',query.returnDate,'🛬 Về',query.destination,query.origin]]){
      lines.push(label+' '+from+' → '+to+' · '+date.split('-').reverse().join('/'));
      const quote=r.legs?.[leg]?.find(q=>q.date===date),flights=choices(quote,date,p.id==='vna'?'VN':'VJ');
      if(!flights.length){lines.push('Chưa có danh sách chuyến có giá cho chiều này.');continue;}
      for(const f of flights){
        const arrival=f.arrival?.slice(11,16)||'?';
        const arrivalDay=f.arrival?.slice(0,10);
        const dayNote=arrivalDay&&arrivalDay!==date?' ('+arrivalDay.split('-').reverse().join('/')+')':'';
        lines.push('• '+f.flight_number+' · '+f.departure.slice(11,16)+' → '+arrival+dayNote+' · '+(f.fare_family||'hạng chưa rõ')+' · '+money(f.price));
        if(Number.isSafeInteger(f.agency_fee)&&f.agency_fee>=0&&Number.isSafeInteger(f.ota_price)&&f.ota_price===f.price+f.agency_fee)
          lines.push('  Qua Flynow: '+money(f.ota_price)+' (phí đại lý '+(f.agency_fee===0?'0đ':money(f.agency_fee))+').');
      }
    }
    lines.push('🕒 Cập nhật '+when(r.observed_at),priceNote(p.id,r),bookingText(p.id,query,r));
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
