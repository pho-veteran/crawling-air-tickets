import {money,routeLine,when} from './messages.mjs';
import {bookingText,priceNote,agencyPrices,flightHint,itineraryOptions} from './booking-links.mjs';
import {trackingMode,trackedLegs} from '../shared/tracking.mjs';

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
  const sections=[trackingMode(query)==='roundtrip'?'✈️ Giờ bay trong hai ngày bạn chọn':'✈️ Giờ bay ngày bạn chọn',routeLine(query),'Giờ đi/đến là giờ Việt Nam (UTC+7). Giá thấp nhất có báo giá cho từng chuyến; chưa giữ chỗ.'];
  for(const p of providers){
    const history=p.history.filter(r=>Date.parse(r.observed_at)<=now),last=history.at(-1);
    const r=history.filter(r=>['ok','partial'].includes(r.status)).at(-1);
    const lines=[(p.id==='vna'?'🟦 ':'🟥 ')+p.name.toUpperCase()];
    if(!r){lines.push('⚠️ Chưa lấy được danh sách chuyến có giá của hãng này.',...itineraryOptions());sections.push(lines.join('\n'));continue;}
    if(last?.status==='error'||r.last_attempt_failed||now-Date.parse(r.observed_at)>(pollMinutes+5)*60000)
      lines.push('⚠️ GIÁ CŨ — lần cập nhật gần nhất '+when(r.observed_at));
    else if(r.status==='partial')lines.push(r.agency_quotes?.some(q=>q.status==='error')||Object.keys(r.leg_errors||{}).length?'⚠️ Nguồn còn thiếu một phần.':'ℹ️ Kết quả từng nguồn được ghi rõ bên dưới.');
    for(const {leg,date,label,from,to} of trackedLegs(query)){
      lines.push(label+' '+from+' → '+to+' · '+date.split('-').reverse().join('/'));
      const quote=r.legs?.[leg]?.find(q=>q.date===date),flights=choices(quote,date,p.id==='vna'?'VN':'VJ');
      if(!flights.length){
        lines.push(...itineraryOptions(quote));
        if(r.agency&&quote?.price===null&&Array.isArray(quote.flights)&&!quote.flights.length&&!r.leg_errors?.[leg])lines.push('• '+r.agency+': không có báo giá phù hợp.');
        else if(r.agency&&r.leg_errors?.[leg])lines.push('• '+r.agency+': chưa cập nhật được.');
        lines.push(...agencyPrices(r,leg,date));continue;
      }
      for(const [label,connecting] of [['Bay thẳng',false],['Nối chuyến',true]]){
        const available=flights.filter(f=>(f.segments?.length>1||f.stops>0)===connecting);
        lines.push(label+(available.length?'':': chưa có báo giá phù hợp'));
        for(const f of available){
          const arrivalDay=f.arrival?.slice(0,10),dayNote=arrivalDay&&arrivalDay!==date?' (đến '+arrivalDay.split('-').reverse().join('/')+')':'';
          lines.push('• '+flightHint(f)+dayNote+' · '+money(f.price));
          if(f.segments?.length>1)for(const s of f.segments)lines.push('  '+s.from+' → '+s.to+' · '+s.flight_number+' · '+s.departure.slice(11,16)+' → '+s.arrival.slice(11,16));
          if(f.price_is_estimate)lines.push('  Qua '+f.agency+' · giá ước tính sau điều chỉnh tạm.');
          else if(Number.isSafeInteger(f.agency_fee)&&f.agency_fee>=0&&Number.isSafeInteger(f.ota_price)&&f.ota_price===f.price+f.agency_fee)
            lines.push('  Qua '+(r.agency||'đại lý')+': '+money(f.ota_price)+' (phí đại lý '+(f.agency_fee===0?'0đ':money(f.agency_fee))+').');
        }
      }
      lines.push(...agencyPrices(r,leg,date));
    }
    lines.push('🕒 Cập nhật '+when(r.observed_at),priceNote(p.id,r),bookingText(p.id,query,r));
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
