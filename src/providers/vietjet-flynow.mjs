import {requestFrom as request,normalizeSearch as normalize,fetchSearch as search,crawlProvider} from './flynow-core.mjs';
export {ENDPOINT,sourcePage} from './flynow-core.mjs';
export const SOURCE='vietjet-flynow-selected-flight-fares-v2';
export const BASIS='Vietjet qua Flynow: cộng hai vé một chiều đúng ngày, gồm thuế/phí hãng, loại phí dịch vụ đại lý theo báo giá; chưa giữ chỗ.';
const provider={airline:'VJ',system:'EVJ',source:SOURCE,name:'Vietjet'};
export const requestFrom=(q,d=q.departureDate,r=q.returnDate)=>request(q,d,r,provider.system);
export const normalizeSearch=(payload,q,d,r,at)=>normalize(payload,q,d,r,at,provider);
export const fetchSearch=(q,d,r,fetchImpl)=>search(q,d,r,fetchImpl,provider);
export const crawl=(q,options)=>crawlProvider(q,provider,options);
