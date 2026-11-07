import {test} from 'node:test';
import assert from 'node:assert/strict';
import {itineraryChoices} from '../src/monitoring/booking-links.mjs';
import {formatFlights} from '../src/monitoring/flights.mjs';

const date='2027-02-10',query={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:date,adults:1,trackingMode:'inbound'};
const segment=(from,to,flight_number,departure,arrival)=>({from,to,flight_number,departure:date+'T'+departure+':00',arrival:date+'T'+arrival+':00'});
const first=segment('VCL','HAN','VN1640','09:15','10:35');
const connecting=(number,price,arrival)=>({date,price,flight_number:'VN1640 + '+number,departure:first.departure,arrival:date+'T'+arrival+':00',fare_family:'Economy',stops:1,segments:[first,segment('HAN','SGN',number,'13:00',arrival)]});
const direct={date,price:4000000,flight_number:'VN1469',departure:date+'T17:50:00',arrival:date+'T19:10:00',segments:[segment('VCL','SGN','VN1469','17:50','19:10')],stops:0};

test('direct and connecting minima remain separate and invalid prices cannot win either category',()=>{
  const connection=connecting('VN205',2500000,'15:10');
  const quote={flights:[connecting('VN207',2800000,'15:40'),direct,connection,{...direct,price:0},{...connection,price:null},{...direct,price:4500000}]};
  assert.deepEqual(itineraryChoices(quote),[direct,connection]);
  assert.deepEqual(itineraryChoices({flights:[connection]}),[null,connection]);
  assert.deepEqual(itineraryChoices({flights:[]}),[null,null]);
});

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
