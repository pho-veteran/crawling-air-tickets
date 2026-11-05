import {money,routeLine,when} from './messages.mjs';
import {bookingText,flightHint,priceNote,agencyPrices} from './booking-links.mjs';
import {trackingMode,trackedLegs} from '../shared/tracking.mjs';
const priced=p=>Number.isSafeInteger(p)&&p>0;
const lowest=values=>{const prices=values.filter(priced);return prices.length?Math.min(...prices):null;};
export function formatProviderStatus(provider,{now=Date.now(),pollMinutes=10}={}){
  const record=provider.history.at(-1);
  if(!record)return provider.name+': chưa có dữ liệu';
  const stamp=Date.parse(record.observed_at),failed=record.status==='error'||record.last_attempt_failed;
  const empty=record.agency_quotes?.some(q=>q.status==='empty')||
    record.agency==='Flynow'&&Object.entries(record.legs||{}).some(([leg,quotes])=>!record.leg_errors?.[leg]&&quotes.some(q=>q.price===null&&Array.isArray(q.flights)&&q.flights.length===0));
  const stale=!Number.isFinite(stamp)||stamp>now||now-stamp>(pollMinutes+5)*60000;
  const status=failed?'⚠️ GIÁ CŨ — lượt cập nhật gần nhất thất bại':
    stale?'⚠️ GIÁ CŨ — chưa có cập nhật mới':empty?
      'ℹ️ không có báo giá phù hợp từ một số nguồn'+(record.agency_quotes?.some(q=>q.status==='error')||Object.keys(record.leg_errors||{}).length?'; có nguồn chưa cập nhật được':''):record.status==='partial'?'⚠️ chưa đủ nguồn/giá':'ok';
  return provider.name+': '+(Number.isFinite(stamp)?when(record.observed_at)+' · ':'')+status;
}
export function formatCurrentPrices({providers,query,now=Date.now(),pollMinutes=10,onDemand=false}){
  const sections=[onDemand?'✈️ Giá vé hiện tại':'☀️ Giá vé hôm nay · 07:00 giờ Việt Nam',routeLine(query)];
  for(const p of providers){
    const history=p.history.filter(r=>Date.parse(r.observed_at)<=now),last=history.at(-1),r=history.filter(r=>['ok','partial'].includes(r.status)).at(-1);
    const lines=[(p.id==='vna'?'🟦 ':'🟥 ')+p.name.toUpperCase()];
    if(!r)lines.push('⚠️ Chưa cập nhật được giá hiện tại.');
    else if(last?.status==='error'||r.last_attempt_failed||now-Date.parse(r.observed_at)>(pollMinutes+5)*60000)lines.push('⚠️ GIÁ CŨ — chưa cập nhật được ở lượt này.');
    else if(r.status==='partial')lines.push((r.agency_quotes?.some(q=>q.status==='empty')&&!r.agency_quotes.some(q=>q.status==='error')||r.agency==='Flynow'&&!Object.keys(r.leg_errors||{}).length&&Object.values(r.legs||{}).some(quotes=>quotes.some(q=>q.price===null&&Array.isArray(q.flights)&&!q.flights.length)))?'ℹ️ Không có báo giá phù hợp từ một số nguồn.':r.price_is_estimate?'⚠️ Chưa lấy đủ giá từ cả hai đại lý'+(priced(r.main_price)?'; đang dùng báo giá hiện có.':'.'):'⚠️ Giá còn thiếu một chiều; không suy diễn là hết vé.');
    if(trackingMode(query)==='roundtrip')lines.push('🎟 Tổng hai chiều: '+money(r?.main_price));
    for(const {leg,date,label} of trackedLegs(query)){
      const quote=r?.legs?.[leg]?.find(q=>q.date===date);
      lines.push(label+' '+date.split('-').reverse().join('/')+': '+money(quote?.price));
      if(r?.agency==='Flynow'&&quote?.price===null&&Array.isArray(quote.flights)&&!quote.flights.length&&!r.leg_errors?.[leg])lines.push('• Flynow: không có báo giá phù hợp.');
      else if(r?.agency==='Flynow'&&r.leg_errors?.[leg])lines.push('• Flynow: chưa cập nhật được.');
      if(priced(quote?.price)&&flightHint(quote))lines.push('Chọn chuyến: '+flightHint(quote));
      lines.push(...agencyPrices(r,leg,date));
    }
    const minima=p.minimums||{
      main:lowest(history.map(r=>r.main_price)),
      outbound:lowest(history.flatMap(r=>r.legs?.outbound?.filter(q=>q.date===query.departureDate).map(q=>q.price)||[])),
      inbound:lowest(history.flatMap(r=>r.legs?.inbound?.filter(q=>q.date===query.returnDate).map(q=>q.price)||[])),
    };
    lines.push('🏷 Thấp nhất '+(r?.price_is_estimate?'ước tính ':'')+'đã ghi nhận: '+(trackingMode(query)==='roundtrip'?'tổng '+money(minima.main)+' · đi '+money(minima.outbound)+' · về '+money(minima.inbound):money(minima[trackingMode(query)])));
    if(r)lines.push('🕒 Cập nhật '+when(r.observed_at));
    lines.push(priceNote(p.id,r),bookingText(p.id,query,r));sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
