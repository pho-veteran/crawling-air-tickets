import {evaluateAlerts,formatAlert,settingsFrom,alertGroups} from '../../src/monitoring/alerts.mjs';
import {formatDaily} from '../../src/monitoring/messages.mjs';
const q={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
const vna={id:'vna',name:'Vietnam Airlines',source:'vna-fare-matrix-v1'},vj={id:'vietjet',name:'Vietjet',source:'vietjet-public-calendar-v1'};
export function smokeCases(now=Date.now()){
  const at=minutes=>new Date(now+minutes*60000).toISOString();
  const snapshot=(minutes,main=5000000,min=4800000)=>{if(main!==null)min=Math.min(main,min);return ({source:vna.source,legs_source:'vna-air-best-price-oneway-v1',query_id:'smoke-only',query:q,status:'ok',observed_at:at(minutes),main_price:main,minimum_price:min,
    cells:[{depart:q.departureDate,return:q.returnDate,price:main},{depart:'2027-02-05',return:'2027-02-15',price:min},{depart:'2027-02-06',return:'2027-02-14',price:min+100000}],
    legs:{outbound:[{date:q.departureDate,price:3000000,fare_family:'SkyBoss'},{date:'2027-02-05',price:2800000}],inbound:[{date:q.returnDate,price:4000000,fare_family:'SkyBoss'},{date:'2027-02-15',price:3800000}]}});};
  const cases=[],settings=settingsFrom({targetVnd:{vna:4500000}}),a=snapshot(-25);
  function alert(name,p,r,h,state={initialized:true}){const events=evaluateAlerts(p,r,h,state,settings);if(!events.length)throw new Error('Smoke thiếu sự kiện: '+name);for(const [i,group] of alertGroups(events).entries())cases.push({name:name+' · sự kiện '+(i+1),keys:group.map(e=>e.key),text:formatAlert(p,r,group,h)});}
  alert('Kích hoạt và mốc giá đầu',vna,a,[],{});
  alert('Giảm khứ hồi + đáy toàn lịch sử + ngân sách',vna,snapshot(0,4200000,4100000),[a]);
  alert('Đáy 7 ngày, chưa phải đáy toàn lịch sử',vna,snapshot(0,4500000),[snapshot(-9*1440,2000000),a]);
  const legs=snapshot(0);for(const leg of Object.values(legs.legs))for(const d of leg)d.price-=500000;
  alert('Vé đi và về giảm, khứ hồi không đổi',vna,legs,[a]);
  const missing={...snapshot(-25,null),source:vj.source,legs_source:vj.source},eco={...snapshot(0),source:vj.source,legs_source:vj.source};
  eco.legs.outbound[0].fare_family='Eco';eco.legs.inbound[0].fare_family='Eco';
  alert('Vietjet có giá lại + nhãn Eco',vj,eco,[missing]);
  const error=minutes=>({...snapshot(minutes,null,null),status:'error',legs:{},cells:[]});
  alert('Nguồn lỗi 3 lượt',vna,error(0),[error(-50),error(-25)]);
  alert('Nguồn phục hồi',vna,snapshot(0),[error(-25)],{initialized:true,incidentOpen:true});
  const yesterday=snapshot(-1440,5500000,4900000),today=snapshot(0,5000000,4000000),vjYesterday={...snapshot(-1440,7500000,4800000),source:vj.source},vjToday={...snapshot(0,7980000,3340000),source:vj.source};
  today.legs.outbound[0].price=2500000;today.legs.inbound[0].price=4500000;
  const providers=[{...vna,history:[yesterday,today]},{...vj,history:[vjYesterday,vjToday]}];
  cases.push({name:'Bản tin 07:00 chung · tăng, giảm, không đổi',keys:['daily'],text:formatDaily({providers,query:q,now})});
  cases.push({name:'Bản tin sáng · giá cũ và hãng thiếu dữ liệu',keys:['daily-stale'],text:formatDaily({providers:[{...vna,history:[yesterday,error(0)]},{...vj,history:[]}],query:q,now})});
  cases.push({name:'Tin dài · chia phần và chữ đậm',keys:['multipart'],text:'📬 KIỂM TRA TIN DÀI\n'+Array.from({length:60},(_,i)=>'🛫 Ô mô phỏng '+(i+1)+': SGN → VCL · 2.500.000đ · ↓ 500.000đ (16.7%) · giữ đầy đủ nội dung.').join('\n')+'\n✅ ĐÂY LÀ DÒNG CUỐI — không bị cắt mất.'});
  return cases.map((c,i)=>({...c,text:'🧪 SMOKE TEST '+(i+1)+'/'+cases.length+' · '+c.name+'\nDỮ LIỆU MÔ PHỎNG — không phải cơ hội mua vé thật.\n\n'+c.text}));
}
