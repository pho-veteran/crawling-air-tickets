import {sourcePage as flynowPage} from '../providers/vietjet-flynow.mjs';
import {trackingMode,trackedLegs} from '../shared/tracking.mjs';
// Recreate searches from the current query, never reuse supplier session URLs.
export function bookingLinks(id,query,record){
  const single=trackingMode(query)!=='roundtrip',leg=trackedLegs(query)[0];
  if(id==='vna')return [{
    label:'Đặt vé VNA (điền sẵn tuyến/ngày; kiểm tra hành khách rồi bấm Tìm chuyến bay)',
    url:'https://www.vietnamairlines.com/vn/vi?'+new URLSearchParams({
      from:leg.from,to:leg.to,departureDate:leg.date,...(single?{}:{returnDate:query.returnDate})})
  },...(record?.agency==='Flynow'?[{label:'Tìm cả hành trình trên Flynow (có phí đại lý; kiểm tra form tuyến/ngày)',url:flynowPage(query)}]:[]),
  ...(record?.price_is_estimate?[{label:'Tìm vé trên BestPrice',url:'https://www.bestprice.vn/ve-may-bay'},{label:'Tìm vé trên ABAY',url:'https://www.abay.vn/'}]:[])];
  if(id!=='vietjet')return [];
  return [
    {label:single?'Tìm vé một chiều trên Vietjet':'Tìm cả hành trình trên Vietjet',url:'https://www.vietjetair.com/vi/?'+new URLSearchParams({
      departAirport:leg.from,arrivalAirport:leg.to,currency:'VND',
      departDate:leg.date,...(single?{}:{returnDate:query.returnDate}),tripType:single?'oneWay':'roundTrip',adultCount:query.adults,languageCode:'vi'})},
    {label:'Tìm cả hành trình trên Flynow (có phí đại lý; kiểm tra form tuyến/ngày)',url:flynowPage(query)}
  ];
}
export const bookingText=(id,query,record)=>bookingLinks(id,query,record).map(({label,url})=>'🔗 '+label+':\n'+url).join('\n\n');
export function flightHint(quote){
  if(!quote?.flight_number)return '';
  const time=typeof quote.departure==='string'?quote.departure.slice(11,16):'';
  return [quote.flight_number,time,quote.fare_family].filter(Boolean).join(' · ');
}
export const isSeparateTickets=record=>['sum-of-oneway-airline-fares-excluding-agency-fee','temporary-agency-adjusted-estimate'].includes(record?.price_basis);
export function priceNote(id,record){
  if(record?.price_is_estimate)return 'ℹ️ Giá ước tính từ BestPrice/ABAY, đã điều chỉnh tạm theo chênh lệch đối chiếu. Giá thanh toán có thể khác; chưa giữ chỗ.';
  return record?.agency==='Flynow'||id==='vietjet'?'ℹ️ '+(id==='vna'?'Vietnam Airlines':'Vietjet')+' qua Flynow: gồm thuế/phí hãng; đã loại phí dịch vụ đại lý theo báo giá, chưa giữ chỗ.':'ℹ️ Gồm thuế theo nguồn; vé từng chiều là giá mua riêng.';
}
export function agencyPrices(record,leg,date){
  const money=n=>new Intl.NumberFormat('vi-VN').format(n)+'đ';
  return (record?.agency_quotes||[]).filter(q=>q.leg===leg&&q.date===date).map(q=>{
    if(q.status!=='ok')return '• '+q.agency+': chưa cập nhật được.';
    const offset=q.adjustment_vnd,adjustment=offset?' '+(offset<0?'−':'+')+money(Math.abs(offset)):'';
    const at=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(q.observed_at));
    return '• '+q.agency+': '+money(q.raw_price)+adjustment+' → '+money(q.price)+' (ước tính; '+at+')'+
      (q.agency_fee>0?' · đã bỏ phí đại lý '+money(q.agency_fee):'');
  });
}
