import {bookingText,flightHint,isSeparateTickets,priceNote} from './booking-links.mjs';
export const money=n=>Number.isSafeInteger(n)&&n>0?new Intl.NumberFormat('vi-VN').format(n)+'đ':'chưa có giá';
const offsetMs=(offset='+07:00')=>(offset[0]==='-'?-1:1)*(Number(offset.slice(1,3))*60+Number(offset.slice(4)))*60000;
export const localDay=(t,offset='+07:00')=>new Date(Number(t)+offsetMs(offset)).toISOString().slice(0,10);
export const morningAt=(t,s={})=>Date.parse(localDay(t,s.dailyUtcOffset)+'T'+(s.dailyTime||'07:00')+':00'+(s.dailyUtcOffset||'+07:00'));
export const nextMorning=(t,s={})=>{const at=morningAt(t,s);return at>t?at:at+86400000;};
export const when=t=>{const d=new Date(t),f=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d),v=Object.fromEntries(f.map(x=>[x.type,x.value]));return v.hour+':'+v.minute+' ngày '+v.day+'/'+v.month+'/'+v.year;};
const day=d=>d.slice(8,10)+'/'+d.slice(5,7),priced=n=>Number.isSafeInteger(n)&&n>0;
export const change=(current,previous)=>!priced(current)||!priced(previous)?'chưa có mốc so sánh':current===previous?'↔ Không đổi':(current<previous?'🟢 ↓ ':'🔺 ↑ ')+money(Math.abs(current-previous))+' ('+(Math.abs(current-previous)/previous*100).toFixed(1)+'%)';
export function routeLine(q){return q.origin+' ⇄ '+q.destination+' · '+day(q.departureDate)+'–'+day(q.returnDate)+'/'+q.returnDate.slice(0,4)+' · '+q.adults+' người lớn';}
export function formatDaily({providers,query,now=Date.now(),pollMinutes=10,settings={},onDemand=false}){
  const offset=settings.dailyUtcOffset||'+07:00',clock=settings.dailyTime||'07:00';
  const sections=[onDemand?'✈️ Giá vé bạn vừa hỏi đây!' :'☀️ Chào buổi sáng! Cùng xem giá vé hôm nay · '+clock,routeLine(query),'📅 '+localDay(now,offset).split('-').reverse().join('/')+' · UTC'+offset];
  for(const p of providers){
    const h=p.history.filter(r=>Date.parse(r.observed_at)<=now),last=h.at(-1),good=h.filter(r=>['ok','partial'].includes(r.status)),r=good.at(-1);
    const previous=good.filter(s=>(onDemand||localDay(Date.parse(s.observed_at),offset)<localDay(now,offset))&&s.observed_at<r?.observed_at).at(-1);
    const lines=[(p.id==='vna'?'🟦 ':'🟥 ')+p.name.toUpperCase()];
    if(!r){lines.push('⚠️ Chưa lấy được giá của hãng này. Có dữ liệu, mình sẽ cập nhật cho bạn.');sections.push(lines.join('\n'));continue;}
    const stale=now-Date.parse(r.observed_at)>(pollMinutes+5)*60000;
    if(last?.status==='error'||stale)lines.push('⚠️ GIÁ CŨ — mình chưa cập nhật được, lần gần nhất là '+when(r.observed_at));
    else if(r.status==='partial')lines.push('⚠️ Lần này chưa lấy đủ giá; những mục còn thiếu sẽ được ghi rõ bên dưới.');
    lines.push((p.id==='vna'&&!isSeparateTickets(r)?'🎟 Vé khứ hồi hiện là ':'🎟 Cộng vé đi và về hiện là ')+money(r.main_price)+' · '+change(r.main_price,previous?.main_price));
    for(const [leg,date,label,from,to] of [['outbound',query.departureDate,'🛫 Vé đi',query.origin,query.destination],['inbound',query.returnDate,'🛬 Vé về',query.destination,query.origin]]){
      const quote=r.legs?.[leg]?.find(x=>x.date===date),before=previous?.legs?.[leg]?.find(x=>x.date===date);
      lines.push(label+' '+from+' → '+to+' · '+day(date)+'/'+date.slice(0,4)+': '+money(quote?.price)+' · '+change(quote?.price,before?.price));
      if(priced(quote?.price)&&flightHint(quote))lines.push('Chọn chuyến: '+flightHint(quote));
      if(!priced(quote?.price)&&r.leg_errors?.[leg])lines.push('⚠️ Chưa cập nhật được giá '+(leg==='outbound'?'chiều đi':'chiều về')+' ở lượt này.');
    }
    const priorPrices=good.filter(x=>priced(x.main_price));
    if(priorPrices.length){const low=priorPrices.reduce((a,b)=>a.main_price<=b.main_price?a:b);lines.push('🏷 Từ khi theo dõi, giá thấp nhất là '+money(low.main_price)+', ghi nhận lúc '+when(low.observed_at)+'.');}
    lines.push('🕒 Cập nhật lúc '+when(r.observed_at)+' (UTC+7)'+(previous?' · So với mốc '+when(previous.observed_at)+(onDemand?' trước đó.':' trước hôm nay.'):' · Chưa có mốc so sánh.'));
    lines.push(priceNote(p.id,r));
    lines.push(bookingText(p.id,query,r));
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
// Offsets use JavaScript UTF-16 indices, as required by Telegram MessageEntity.
export function messageEntities(text){
  const spans=[];const add=(offset,length)=>{if(length>0&&!spans.some(s=>offset<s.offset+s.length&&offset+length>s.offset))spans.push({type:'bold',offset,length});};
  add(0,text.indexOf('\n')<0?text.length:text.indexOf('\n'));
  for(const m of text.matchAll(/^(?:🟦|🟥|⚠️ GIÁ CŨ)[^\n]*/gm))add(m.index,m[0].length);
  for(const m of text.matchAll(/\d[\d.]*đ(?: \([\d.]+%\))?/g))add(m.index,m[0].length);
  return spans.sort((a,b)=>a.offset-b.offset);
}
