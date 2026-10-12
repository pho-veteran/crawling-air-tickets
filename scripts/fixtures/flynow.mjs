// Synthetic prices only. No supplier session/selection values.
export function fare(leg,query,date,price=leg?2400000:1800000,{fee=50000,base=price-600000}={}){
  const from=leg?query.destination:query.origin,to=leg?query.origin:query.destination;
  return {Airline:'VJ',System:'EVJ',Currency:'VND',Adt:1,Chd:0,Inf:0,Itinerary:leg+1,
    FareAdt:base,TaxAdt:price-base,ServiceFeeAdt:fee,PriceAdt:price+fee,
    TotalFare:base,TotalTax:price-base,TotalServiceFee:fee,TotalPrice:price+fee,
    TotalAgentDiscount:0,TotalAirlineDiscount:0,ListOption:[{ListFlight:[{
      Leg:leg,Airline:'VJ',Operating:'VJ',StartPoint:from,EndPoint:to,StartDate:date+'T06:00:00',EndDate:date+'T07:20:00',
      FlightNumber:leg?'VJ371':'VJ370',StopNum:0,ListSegment:[{Status:'OK',SeatAvl:9,FareBasis:'T1ECO',FareType:'Eco',AllowanceBaggage:'',HandBaggage:'7 KG'}]
    }]}]};
}
export function simulatedFlynow(query,{outbound=1800000,inbound=2400000,failLeg,fee=50000}={}){
  const requests=[];
  return {requests,fetch:async(url,options)=>{
    requests.push(url);
    if(failLeg==='both')return new Response('',{status:503});
    const flights=JSON.parse(options.body.get('listFlight'));
    const ListFareData=flights.flatMap(f=>{
      const leg=f.Leg?'inbound':'outbound';if(leg===failLeg)return [];
      const d=f.DepartDate,date=d.slice(4)+'-'+d.slice(2,4)+'-'+d.slice(0,2);
      const offset=(Date.parse(date)-Date.parse(f.Leg?query.returnDate:query.departureDate))/86400000;
      return [fare(f.Leg,query,date,(f.Leg?inbound:outbound)+offset*10000,{fee})];
    });
    return Response.json({Status:true,ListFareData});
  }};
}
