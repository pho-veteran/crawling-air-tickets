import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bookingLinks} from '../src/monitoring/booking-links.mjs';
import {formatDaily} from '../src/monitoring/messages.mjs';
import {formatAlert} from '../src/monitoring/alerts.mjs';
import {sendTelegram} from '../src/telegram/client.mjs';

const query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const record={query,source:'vietjet-flynow-airline-fare-v1',status:'ok',observed_at:'2026-10-12T09:35:00Z',main_price:7255962,
  legs:{outbound:[{date:query.departureDate,price:2385181,flight_number:'VJ376',departure:'2027-02-04T14:10:00',fare_family:'Eco'}],
    inbound:[{date:query.returnDate,price:4870781,flight_number:'VJ371',departure:'2027-02-13T07:50:00',fare_family:'SkyBoss'}]}};
const provider={id:'vietjet',name:'Vietjet',history:[record]};

test('booking links preserve itinerary parameters and label Flynow form caveat',()=>{
  const q={...query,origin:'VCL',destination:'SGN',departureDate:'2027-03-01',returnDate:'2027-03-09',adults:2};
  const [direct,ota]=bookingLinks('vietjet',q).map(x=>new URL(x.url));
  assert.equal(direct.searchParams.get('departAirport'),'VCL');assert.equal(direct.searchParams.get('arrivalAirport'),'SGN');
  assert.equal(direct.searchParams.get('departDate'),q.departureDate);assert.equal(direct.searchParams.get('returnDate'),q.returnDate);
  assert.equal(direct.searchParams.get('adultCount'),'2');assert.equal(direct.searchParams.get('tripType'),'roundTrip');
  assert.equal(ota.pathname,'/flights');
  assert.equal(ota.searchParams.get('sp'),q.origin);assert.equal(ota.searchParams.get('ep'),q.destination);
  assert.equal(ota.searchParams.get('dt'),'01032027.09032027');assert.equal(ota.searchParams.get('ps'),'2.0.0');
  assert.match(bookingLinks('vietjet',q)[1].label,/kiểm tra form tuyến\/ngày/);
  assert.doesNotMatch(direct.href+ota.href,/session|token|selection|bookingId/i);
  assert.match(bookingLinks('vna',q)[0].label,/nhập lại tuyến\/ngày/);
});

test('daily, on-demand and directional alerts deliver clickable booking URLs and the matching flight',async()=>{
  const texts=[false,true].map(onDemand=>formatDaily({providers:[provider],query,now:Date.parse(record.observed_at),onDemand}));
  const event={key:'leg',text:'Vé về giảm 100.000đ',guard:{kind:'leg',leg:'inbound',date:query.returnDate,price:4870781}};
  const alert=formatAlert(provider,record,[event]);texts.push(alert);
  assert.match(alert,/Về: VJ371 · 07:50 · SkyBoss/);assert.doesNotMatch(alert,/VJ376/);
  for(const text of texts){
    const delivered=[];
    await sendTelegram({configured:true,enabled:true,chatId:'test',token:'123:TEST'},text,async(url,init)=>{
      delivered.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});
    });
    assert.equal(delivered.length,1);
    for(const {url} of bookingLinks('vietjet',query))assert.ok(delivered[0].text.includes(url));
    assert.doesNotMatch(delivered[0].text,/HTML|\/report/);
    assert.match(delivered[0].text,/Flynow \(có phí đại lý; kiểm tra form tuyến\/ngày\)/);
    assert.match(delivered[0].text,/flynow\.vn\/flights\?/);
  }
  assert.match(texts[0],/VJ376 · 14:10 · Eco/);
});
