import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatFlights} from '../src/monitoring/flights.mjs';
import {formatCurrentPrices} from '../src/monitoring/current-prices.mjs';
import {formatAlert} from '../src/monitoring/alerts.mjs';

const date='2027-02-10',query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:date,adults:1,trackingMode:'inbound'};
const segment=(from,to,flight_number,departure,arrival)=>({from,to,flight_number,departure:date+'T'+departure+':00',arrival:date+'T'+arrival+':00'});
const first=segment('VCL','HAN','VN1640','09:15','10:35');
const connecting=(number,price,arrival)=>({date,price,flight_number:'VN1640 + '+number,departure:first.departure,arrival:date+'T'+arrival+':00',fare_family:'Economy',stops:1,segments:[first,segment('HAN','SGN',number,'13:00',arrival)]});
const direct={date,price:4000000,flight_number:'VN1469',departure:date+'T17:50:00',arrival:date+'T19:10:00',segments:[segment('VCL','SGN','VN1469','17:50','19:10')],stops:0};


test('connecting flights sharing a first segment are distinct choices, and a dearer fare for the same itinerary is suppressed',()=>{
  const a=connecting('VN205',2500000,'15:10'),b=connecting('VN207',2800000,'15:40');
  const observed_at='2026-11-07T06:00:00Z';
  const record={query,observed_at,currency:'VND',status:'ok',main_price:a.price,legs:{inbound:[{...a,flights:[a,b,{...a,price:3000000,fare_family:'Dearer'},direct]}]}};
  const text=formatFlights({providers:[{id:'vna',name:'Vietnam Airlines',history:[record]}],query,now:Date.parse(observed_at)});
  assert.ok(text.includes('VN1640 + VN205')&&text.includes('VN1640 + VN207')&&text.includes('VN1469'));
  assert.ok(text.includes('VCL → HAN')&&text.includes('HAN → SGN'));
  assert.ok(text.includes('2.500.000đ')&&text.includes('2.800.000đ')&&text.includes('4.000.000đ'));
  assert.ok(!text.includes('3.000.000đ')&&!text.includes('Dearer'));
});

test('the old compact layout is preserved for direct flights, with no empty classification sections',()=>{
  const observed_at='2026-11-07T06:00:00Z';
  const vj={...direct,flight_number:'VJ371',fare_family:'SkyBoss',price:4870781};
  const record={query,observed_at,status:'ok',agency:'BestPrice',main_price:vj.price,legs:{inbound:[{...vj,flights:[vj]}]}};
  const provider={id:'vietjet',name:'Vietjet',history:[record]},now=Date.parse(observed_at);
  const price=formatCurrentPrices({providers:[provider],query,now,onDemand:true});
  assert.match(price,/Về 10\/02\/2027: 4\.870\.781đ\nChọn chuyến: VJ371 · 17:50 · SkyBoss/);
  assert.ok(price.indexOf('Chọn chuyến:')<price.indexOf('🏷 Thấp nhất'));
  assert.ok(price.indexOf('🏷 Thấp nhất')<price.indexOf('🕒 Cập nhật'));
  assert.ok(price.indexOf('🕒 Cập nhật')<price.indexOf('🔗 '));
  const flights=formatFlights({providers:[provider],query,now});
  assert.match(flights,/• VJ371 · 17:50 → 19:10 · SkyBoss · 4\.870\.781đ/);
  for(const text of [price,flights])assert.doesNotMatch(text,/Bay thẳng|Nối chuyến|nguồn giá lịch không phân loại/);
});

test('connecting inventory is appended without changing the selected whole-itinerary price',()=>{
  const a=connecting('VN205',2500000,'15:10'),b=connecting('VN207',2800000,'15:40');
  const observed_at='2026-11-07T06:00:00Z';
  const record={query,observed_at,status:'ok',main_price:a.price,legs:{inbound:[{...a,flights:[a,b,direct]}]}};
  const provider={id:'vna',name:'Vietnam Airlines',history:[record]},now=Date.parse(observed_at);
  const price=formatCurrentPrices({providers:[provider],query,now,onDemand:true});
  assert.match(price,/Về 10\/02\/2027: 2\.500\.000đ\nChọn chuyến: VN1640 \+ VN205/);
  assert.ok(price.indexOf('🔀 Nối chuyến')>price.indexOf('🔗 '));
  for(const n of ['VN1640 + VN205','VN1640 + VN207'])assert.ok(price.includes(n));
  const alert=formatAlert(provider,record,[{key:'leg',text:'Giá giảm',guard:{kind:'leg',leg:'inbound',date,price:a.price}}]);
  assert.ok(alert.includes('🔀 Nối chuyến'));assert.doesNotMatch(alert,/✈️ Về: VN1469/);
  const only={...record,legs:{inbound:[{...a,flights:[a]}]}};
  const onlyText=formatCurrentPrices({providers:[{...provider,history:[only]}],query,now});
  assert.match(onlyText,/Về 10\/02\/2027: 2\.500\.000đ/);
  assert.ok(onlyText.includes('🔀 Nối chuyến'));
});

test('calendar-only reference retains its amount without inventing flight classifications',()=>{
  const observed_at='2026-11-07T06:00:00Z';
  const record={query,observed_at,status:'ok',reference_only:true,main_price:6099181,legs:{inbound:[{date,price:6099181,reference_only:true,flights:[]}]}};
  const provider={id:'vna',name:'Vietnam Airlines',history:[record]},now=Date.parse(observed_at);
  const price=formatCurrentPrices({providers:[provider],query,now});
  assert.match(price,/Về 10\/02\/2027: 6\.099\.181đ/);
  assert.match(price,/API không trả giờ bay/);
  assert.doesNotMatch(price,/🔀 Nối chuyến|Chọn chuyến:/);
  assert.doesNotMatch(formatFlights({providers:[provider],query,now}),/🔀 Nối chuyến|nguồn giá lịch không phân loại/);
});
