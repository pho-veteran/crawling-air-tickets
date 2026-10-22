import {simulatedFlynow} from './flynow.mjs';
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function simulatedSources(query,{outbound=1800000,inbound=2400000,failAgency,...options}={}){
  const old=simulatedFlynow(query,{outbound,inbound,...options}),requests=[];let abay;
  const leg=(from,to,date)=>({from,to,date,inbound:from===query.destination});
  const amount=l=>l.inbound?inbound:outbound;
  const offset=(l,id)=>l.from==='VCL'&&l.to==='SGN'&&l.date==='2027-02-13'?(id==='bp'?-819:181):0;
  const wire=l=>{const p=l.date.split('-');return p[2]+months[Number(p[1])-1]+p[0];};
  const number=l=>l.inbound?'VN1469':'VN1468';
  const formDate=d=>d.split('/').reverse().join('-');
  return {requests,fetch:async(url,opts={})=>{
    requests.push(String(url));const u=new URL(url);
    if(u.hostname.includes('flynow'))return old.fetch(url,opts);
    if(options.failLeg==='both'||u.hostname.includes(failAgency||'NEVER'))return new Response('',{status:503});
    if(u.hostname==='www.bestprice.vn'){
      const p=u.searchParams;
      if(u.pathname==='/get-vnisc-sid.html')return Response.json({vnisc_sid:'FAKE'});
      if(u.pathname==='/ajax-search-flight-bp'){
        const l=leg(p.get('From_Code'),p.get('To_Code'),formDate(p.get('Depart'))),price=amount(l)-offset(l,'bp');
        return Response.json({search_status:'DONE',search_data:{flight_data:[{Airlines:'VN',From:l.from,To:l.to,Stop:0,FlightNumber:number(l),DateFrom:l.date+' 06:00:00',DateTo:l.date+' 07:20:00',
          PriceInfo:[{Seat:8,Class:'J',ADT_Fare:price-600000,ADT_Tax:600000,BP_Fee:50000,BP_Discount:0,BP_Discount_Total:0}]}]}});
      }
      const from=p.get('From').match(/\(([A-Z]{3})\)/)[1],to=p.get('To').match(/\(([A-Z]{3})\)/)[1];
      const search=new URLSearchParams({From_Code:from,To_Code:to,Depart:p.get('Depart'),Return:'',ADT:'1',CHD:'0',INF:'0'});
      return new Response('<input id="sid" value="FAKE"><input id="search_flight_url" value="'+search+'">');
    }
    if(u.hostname==='www.abay.vn'){
      if(u.pathname==='/'){
        if(opts.method==='POST'){
          const f=opts.body;abay=leg(f.get('hdfstartplace'),f.get('hdfendplace'),f.get('hdfDepartureDate').split('-').reverse().join('-'));
          return new Response('',{status:302,headers:{location:'/fixture-results'}});
        }
        return new Response('<input name="__VIEWSTATE" value="FAKE"><input name="ctl00$cphMain$ctl00$usrSearchFormD2$btnSearch" type="submit" value="Search">');
      }
      if(u.pathname==='/fixture-results')return new Response('<div id=sInfo>'+abay.from+'-'+abay.to+'-1-0-0-'+wire(abay)+'-</div>');
      const price=amount(abay)-offset(abay,'abay'),base=price-600000;
      if(u.pathname.endsWith('/GetFlights'))return Response.json({d:JSON.stringify({D:[{E:'VN',F:number(abay),G:'06:00',H:'07:20',J:String(base),L:String(base),O:'Business',
        N:abay.from+'-'+abay.to+'-'+wire(abay)+'-06:00|'+number(abay)+'-06:00-07:20,32kg-'+base+',J-321-JHVNF-OperateAirlineVN-SeatRemain8-0--8--MD0',T:'/_Web/ResultDom2024/usrDesktop/FlightDetail.aspx'}]})});
      if(u.pathname.endsWith('/FlightDetail.aspx'))return new Response('<table class=price-break><tr><td class=pax>Người lớn<td class=pax>1<td class=pax>'+base+' VNĐ<td class=pax>600000 VNĐ<td class="pax pb-price">'+price+' VNĐ<tr class=total-b></table>');
    }
    throw new Error('Unexpected fixture source '+u.host);
  }};
}
