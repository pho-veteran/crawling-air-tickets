// Public search links only: no session, fare-selection token or reservation.
// Vietjet prefills its form. Flynow's result URL leaves the form on browser-saved
// defaults, so do not advertise that URL as a prefilled booking shortcut.
export function bookingLinks(id,query){
  if(id==='vna')return [{label:'Đặt vé VNA (nhập lại tuyến/ngày)',url:'https://www.vietnamairlines.com/vn/vi'}];
  if(id!=='vietjet')return [];
  return [
    {label:'Tìm cả hành trình trên Vietjet',url:'https://www.vietjetair.com/vi/?'+new URLSearchParams({
      departAirport:query.origin,arrivalAirport:query.destination,currency:'VND',
      departDate:query.departureDate,returnDate:query.returnDate,tripType:'roundTrip',adultCount:query.adults,languageCode:'vi'})},
    {label:'Đặt tại Flynow (nhập lại tuyến/ngày, có phí đại lý)',url:'https://www.flynow.vn/'}
  ];
}
export const bookingText=(id,query)=>bookingLinks(id,query).map(({label,url})=>'🔗 '+label+':\n'+url).join('\n\n');
export function flightHint(quote){
  if(!quote?.flight_number)return '';
  const time=typeof quote.departure==='string'?quote.departure.slice(11,16):'';
  return [quote.flight_number,time,quote.fare_family].filter(Boolean).join(' · ');
}
