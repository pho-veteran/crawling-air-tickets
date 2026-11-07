// Disposable read-only source investigation; never imports a feed or sends Telegram.
const search={commercialFareFamilies:['WEB'],itineraries:[{departureDateTime:'2027-02-10',originLocationCode:'VCL',destinationLocationCode:'SGN'}],travelers:[{passengerTypeCode:'ADT'}]};
const form=new URLSearchParams({search:JSON.stringify(search),portalFacts:JSON.stringify([{key:'countryCode',value:'VN'},{key:'language',value:'vi-VN'}])});
const response=await fetch('https://booking.vietnamairlines.com/booking/availability/0?lang=vi-VN',{method:'POST',body:form,redirect:'manual',signal:AbortSignal.timeout(30000)});
const html=await response.text();console.log(JSON.stringify({event:'bootstrap',status:response.status,type:response.headers.get('content-type'),bytes:html.length,has_config:html.includes('data-bootstrapconfig'),title:html.match(/<title[^>]*>([^<]*)/i)?.[1]}));
if(!response.ok){process.exitCode=1;}else{
 const decode=s=>s.replaceAll('&quot;','"').replaceAll('&#34;','"').replaceAll('&amp;','&').replaceAll('&#39;',"'");
 const raw=html.match(/data-bootstrapconfig=(?:"([^"]*)"|'([^']*)')/i);if(!raw)throw new Error('No public bootstrap config');
 const config=JSON.parse(decode(raw[1]||raw[2]));
 if(config.gatewayBaseUrl!=='https://api-des.vietnamairlines.com'||config.gatewayEndPoint!=='/v1/security/oauth2')throw new Error('Unexpected API origin');
 const init=await fetch(config.gatewayBaseUrl+config.gatewayEndPoint+'/token/initialization',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.gatewayClientId,client_secret:config.gatewayClientSecret,grant_type:'client_credentials',fact:JSON.stringify({keyValuePairs:[{key:'countryCode',value:'VN'},{key:'language',value:'vi-VN'}]})}),signal:AbortSignal.timeout(30000)});
 console.log(JSON.stringify({event:'initialization',status:init.status}));if(!init.ok)throw new Error('Public initialization unavailable');
 const token=await init.json();if(typeof token.access_token!=='string')throw new Error('Missing public session');
 const result=await fetch(config.gatewayBaseUrl+'/v2/search/air-bounds',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token.access_token},body:JSON.stringify(search),signal:AbortSignal.timeout(45000)});
 const text=await result.text();console.log(JSON.stringify({event:'air_bounds',status:result.status,type:result.headers.get('content-type'),bytes:text.length}));
 if(!result.ok){process.exitCode=1;}else if(/json/i.test(result.headers.get('content-type')||'')){const data=JSON.parse(text);console.log(JSON.stringify(data,(key,value)=>/token|session|authorization|secret/i.test(key)?undefined:value));}else throw new Error('Non-JSON availability response');
}
