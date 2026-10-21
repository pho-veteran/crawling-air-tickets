export function trackingMode(query={}){
  const mode=query.trackingMode??'roundtrip';
  if(!['outbound','inbound','roundtrip'].includes(mode))throw new Error('monitoring.trackingMode: cần outbound, inbound hoặc roundtrip.');
  return mode;
}
export function trackedLegs(q){
  const legs=[{leg:'outbound',date:q.departureDate,from:q.origin,to:q.destination,label:'Đi'},
    {leg:'inbound',date:q.returnDate,from:q.destination,to:q.origin,label:'Về'}];
  return legs.filter(x=>trackingMode(q)==='roundtrip'||x.leg===trackingMode(q));
}
export const trackingLabel=q=>({outbound:'Chỉ vé đi',inbound:'Chỉ vé về',roundtrip:'Khứ hồi'})[trackingMode(q)];
export function trackedRecord(record,query){
  const legs=Object.fromEntries(trackedLegs(query).map(l=>[l.leg,record.legs?.[l.leg]||[]]));
  const roundtrip=trackingMode(query)==='roundtrip';
  return {...record,query,legs,main_price:roundtrip?(trackingMode(record.query)==='roundtrip'?record.main_price:null):
    legs[trackingMode(query)].find(q=>q.date===trackedLegs(query)[0].date)?.price??null,
    cells:roundtrip&&trackingMode(record.query)==='roundtrip'?record.cells||[]:[]};
}
