import {when} from './messages.mjs';
import {bookingText,flightHint} from './booking-links.mjs';
const money=n=>new Intl.NumberFormat('vi-VN').format(n)+'đ';
const hasPrice=n=>Number.isSafeInteger(n)&&n>0;
const day=d=>d.slice(8,10)+'/'+d.slice(5,7);
const pair=c=>day(c.depart)+'–'+day(c.return);
const valid=s=>s&&['ok','partial'].includes(s.status);
const legSource=s=>s.legs_source||s.source;
export const defaults={pollMinutes:10,dailyReport:true,priceOnly:false,mainDropMinVnd:1,legDropMinVnd:1,rollingWindowDays:7,repeatCooldownHours:24,errorAfterConsecutive:3,targetVnd:{vna:null,vietjet:null}};
export function settingsFrom(config,env=process.env) {
  const s={...defaults,...config,targetVnd:{...defaults.targetVnd,...config?.targetVnd}};
  s.dailyTime=env.DAILY_REPORT_TIME||'07:00';s.dailyUtcOffset=env.DAILY_REPORT_UTC_OFFSET||'+07:00';
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyTime))throw new Error('DAILY_REPORT_TIME cần HH:mm.');
  if(!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(s.dailyUtcOffset)||Number(s.dailyUtcOffset.slice(1,3))===14&&s.dailyUtcOffset.slice(4)!=='00')throw new Error('DAILY_REPORT_UTC_OFFSET cần dạng +07:00, tối đa 14 giờ.');
  for(const key of ['pollMinutes','mainDropMinVnd','legDropMinVnd','rollingWindowDays','repeatCooldownHours','errorAfterConsecutive'])
    if(!Number.isFinite(s[key])||s[key]<=0)throw new Error('monitoring.'+key+' phải là số dương.');
  if(!Number.isInteger(s.pollMinutes)||s.pollMinutes<10||s.pollMinutes>30)throw new Error('pollMinutes phải là số nguyên từ 10 đến 30.');
  if(typeof s.dailyReport!=='boolean')throw new Error('dailyReport phải là true/false.');
  if(typeof s.priceOnly!=='boolean')throw new Error('priceOnly phải là true/false.');
  if(!Number.isInteger(s.errorAfterConsecutive))throw new Error('errorAfterConsecutive phải là số nguyên.');
  for(const v of Object.values(s.targetVnd))if(v!==null&&!hasPrice(v))throw new Error('targetVnd phải là VND nguyên dương hoặc null.');
  return s;
}
export function evaluateAlerts(provider,record,history,state={},settings=defaults) {
  const events=[],add=(key,text,guard)=>events.push({key,text,guard});
  const earlier=history.filter(s=>s.observed_at<record.observed_at),good=earlier.filter(valid),prev=good.at(-1);
  const mainPast=good.filter(s=>hasPrice(s.main_price));
  if(record.status==='error') {
    let errors=1;for(const s of [...earlier].reverse()){if(s.status!=='error')break;errors++;}
    if(errors>=settings.errorAfterConsecutive&&!state.incidentOpen)add('error','Mình chưa lấy được giá sau '+errors+' lượt kiểm tra liên tiếp. Bạn vẫn xem được lịch sử, nhưng giá cũ có thể đã thay đổi.',{kind:'error'});
    return events;
  }
  if(!valid(record))return events;
  if(state.incidentOpen)add('recovery','Lấy được giá trở lại rồi! Mình tiếp tục canh vé cho bạn nhé.',{kind:'recovery'});
  if(!state.initialized&&hasPrice(record.main_price))add('baseline','Bắt đầu canh vé cho bạn rồi nhé! Giá khởi điểm là '+money(record.main_price)+'.',{kind:'main',price:record.main_price});
  const reasons=[];
  if(hasPrice(record.main_price)) {
    if(hasPrice(prev?.main_price)&&prev.main_price-record.main_price>=settings.mainDropMinVnd)
      reasons.push('Giảm '+money(prev.main_price-record.main_price)+' ('+((prev.main_price-record.main_price)/prev.main_price*100).toFixed(1)+'%) so với lần có dữ liệu trước: '+money(prev.main_price));
    if(mainPast.length&&record.main_price<Math.min(...mainPast.map(s=>s.main_price)))reasons.push('Đây là giá thấp nhất mình từng thấy từ khi bắt đầu theo dõi! ');
    const window=mainPast.filter(s=>Date.parse(record.observed_at)-Date.parse(s.observed_at)<=settings.rollingWindowDays*86400000);
    if(window.length&&record.main_price<Math.min(...window.map(s=>s.main_price))&&!reasons.some(x=>x.includes('từng thấy')))reasons.push('Thấp nhất trong '+settings.rollingWindowDays+' ngày quan sát gần đây');
    if(prev&&prev.main_price===null)reasons.push('Ngày bạn muốn bay đã có giá trở lại rồi! ');
    const target=settings.targetVnd[provider.id];
    if(target!==null&&record.main_price<=target&&(!state.initialized||!hasPrice(prev?.main_price)||prev.main_price>target||record.main_price<prev.main_price))reasons.push('Vừa chạm ngân sách bạn đặt: '+money(target));
    if(reasons.length)add('main:'+record.main_price,reasons.join(' · '),{kind:'main',price:record.main_price});
  }
  for(const [leg,mainDate,from,to,label] of [['outbound',record.query.departureDate,record.query.origin,record.query.destination,'Vé đi'],['inbound',record.query.returnDate,record.query.destination,record.query.origin,'Vé về']]){
    for(const quote of record.legs?.[leg]||[]){
      if(quote.date!==mainDate||!hasPrice(quote.price))continue;
      const past=good.filter(s=>legSource(s)===legSource(record)).map(s=>{
        const value=s.legs?.[leg]?.find(x=>x.date===quote.date);
        return value?{...value,observed_at:value.observed_at||s.observed_at}:null;
      }).filter(x=>x&&hasPrice(x.price));
      if(!past.length)continue; // The first quote is a baseline, never a historical low alert.
      const previous=past.at(-1),main=quote.date===mainDate,why=[];
      if(previous.price-quote.price>=settings.legDropMinVnd)
        why.push('giảm '+money(previous.price-quote.price)+' ('+((previous.price-quote.price)/previous.price*100).toFixed(1)+'%), trước '+money(previous.price));
      const lowest=values=>values.reduce((min,x)=>Math.min(min,x.price),Infinity);
      const allLow=quote.price<lowest(past);
      const window=past.filter(x=>Date.parse(quote.observed_at||record.observed_at)-Date.parse(x.observed_at)<=settings.rollingWindowDays*86400000);
      if(allLow)why.push('chưa từng thấy vé chiều này, ngày này rẻ hơn kể từ khi theo dõi! ');
      else if(window.length&&quote.price<lowest(window))why.push('giá tốt nhất của chiều bay này trong '+settings.rollingWindowDays+' ngày vừa qua');
      if(why.length)add('leg:'+legSource(record)+':'+leg+':'+quote.date+':'+quote.price,
        label+' '+from+' → '+to+' '+day(quote.date)+'/'+quote.date.slice(0,4)+': '+money(quote.price)+' · '+why.join(' · '),
        {kind:'leg',source:legSource(record),leg,date:quote.date,price:quote.price});
    }
  }
  if(prev) {
    for(const [leg,date] of [['outbound',record.query.departureDate],['inbound',record.query.returnDate]]) {
      const current=record.legs?.[leg]?.find(x=>x.date===date),previous=prev.legs?.[leg]?.find(x=>x.date===date);
      if(current?.fare_family==='Eco'&&previous&&previous.fare_family!=='Eco')add('eco:'+leg+':'+date,'Nguồn Vietjet xuất hiện vé Eco ở chiều '+(leg==='outbound'?'đi':'về')+' '+day(date)+'. Giá qua Flynow, chưa giữ chỗ.',{kind:'fare',leg,date,fare:'Eco'});
    }
  }
  return events;
}
export function stillRelevant(event,record) {
  const g=event.guard;
  if(['minimum','flex','cell'].includes(g.kind)||g.kind==='leg'&&g.date!==(g.leg==='outbound'?record.query.departureDate:record.query.returnDate))return false;
  if(g.kind==='error')return record.status==='error';
  if(!valid(record))return false;
  if(g.kind==='recovery')return true;
  if(g.kind==='main')return record.main_price===g.price;
  if(g.kind==='fare')return record.legs?.[g.leg]?.some(x=>x.date===g.date&&x.fare_family===g.fare);
  if(g.kind==='leg')return legSource(record)===g.source&&record.legs?.[g.leg]?.some(x=>x.date===g.date&&x.price===g.price);
  return false;
}
export function alertGroups(events){
  const groups=new Map();for(const e of events){const g=e.guard,key=['leg','fare'].includes(g.kind)?g.leg+':'+g.date:g.kind==='main'?'main':e.key;const list=groups.get(key)||[];list.push(e);groups.set(key,list);}return [...groups.values()];
}
export function formatAlert(provider,record,events,history=[]) {
  const q=record.query,g=events.find(e=>e.guard.kind==='leg')?.guard||events[0]?.guard;
  const dropped=events.some(e=>/giảm/i.test(e.text));
  const title=record.status==='error'?'⚠️ Tạm chưa lấy được giá':dropped?'🎉 Giá vé vừa giảm!':events.some(e=>e.key==='recovery')?'✅ Lấy được giá trở lại rồi!':events.some(e=>e.key==='baseline')?'👋 Bắt đầu canh vé cho bạn!':'✨ Có cập nhật giá vé cho bạn!';
  const leg=g?.kind==='leg'||g?.kind==='fare';
  const heading=provider.name+' · '+(leg?(g.leg==='outbound'?'Vé đi '+q.origin+' → '+q.destination:'Vé về '+q.destination+' → '+q.origin)+' · '+day(g.date)+'/'+g.date.slice(0,4):q.origin+' ⇄ '+q.destination+' · '+pair({depart:q.departureDate,return:q.returnDate})+'/'+q.returnDate.slice(0,4));
  const rows=[title,heading+' · '+q.adults+' người lớn'];
  if(!leg&&hasPrice(record.main_price))rows.push('🎟 '+(provider.id==='vietjet'?'Tổng hai chiều':'Khứ hồi')+' hiện là '+money(record.main_price)+'.');
  rows.push(...events.filter(e=>e.key!=='baseline'&&e.key!=='recovery').map(e=>e.text.split(' · ').filter(t=>!t.includes('thấp nhất mình từng thấy')&&!t.includes('chưa từng thấy vé chiều')).join('\n').trim()));
  const past=history.filter(r=>r.observed_at<=record.observed_at&&valid(r));if(valid(record))past.push(record);
  const quotes=past.filter(r=>!leg||legSource(r)===legSource(record)).map(r=>({price:leg?r.legs?.[g.leg]?.find(x=>x.date===g.date)?.price:r.main_price,at:r.observed_at})).filter(x=>hasPrice(x.price));
  if(quotes.length){const low=quotes.reduce((a,b)=>a.price<=b.price?a:b);rows.push('🏷 Thấp nhất từ khi theo dõi: '+money(low.price)+' ('+when(low.at)+').');}
  rows.push('🕒 '+when(record.observed_at)+' · giờ Việt Nam');
  rows.push(provider.id==='vietjet'?'ℹ️ Vietjet qua Flynow: gồm thuế/phí hãng; đã loại phí dịch vụ đại lý theo báo giá, chưa giữ chỗ.':'ℹ️ Gồm thuế theo nguồn; vé từng chiều là giá mua riêng.');
  for(const [direction,date,label] of [['outbound',q.departureDate,'Đi'],['inbound',q.returnDate,'Về']]){
    if(leg&&direction!==g.leg)continue;
    const quote=record.legs?.[direction]?.find(x=>x.date===(leg?g.date:date));
    if(valid(record)&&hasPrice(quote?.price)&&flightHint(quote))rows.push('✈️ '+label+': '+flightHint(quote));
  }
  rows.push(bookingText(provider.id,q));
  return rows.filter(Boolean).join('\n');
}
