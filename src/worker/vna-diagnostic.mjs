import {ENDPOINT,requestFrom,dateRange,queryFrom} from '../providers/vna-core.mjs';
import {ENDPOINT as ONEWAY,oneWayRequest} from '../providers/vna-oneway.mjs';
import config from '../../config.json' with {type:'json'};

const allowedHeaders=['content-type','server','via','x-cache','cf-ray','cf-mitigated','retry-after','x-amz-cf-id','x-amz-cf-pop','x-sucuri-block','x-akamai-transformed'];
export function fingerprint(text){
  const title=text.match(/<title[^>]*>([^<]{0,200})<\/title>/i)?.[1]?.trim();
  const known=['Access Denied','Forbidden','Request blocked','The request could not be satisfied','Sorry, you have been blocked','Attention Required','Just a moment','cloudflare','CloudFront','Akamai','Incapsula','Imperva','Sucuri','You don\'t have permission','cf-chl','automated','bot detection'];
  const markers=known.filter(phrase=>text.toLowerCase().includes(phrase.toLowerCase()));
  const codes=[...new Set([...text.matchAll(/(?:error(?: code)?[\s:<\/a-z-]*|Cloudflare Ray ID:?[\s<]*)\b(10\d{2})\b/gi)].map(m=>m[1]))];
  return {title,markers,error_codes:codes};
}
export async function diagnose({fetchImpl=fetch,runId=crypto.randomUUID()}={}){
  const query=queryFrom(config),observed_at=new Date().toISOString();
  const specs=[['matrix',ENDPOINT,requestFrom(query)],
    ['outbound',ONEWAY,oneWayRequest(query.origin,query.destination,dateRange(query.departureDate))],
    ['inbound',ONEWAY,oneWayRequest(query.destination,query.origin,dateRange(query.returnDate))]];
  const results=await Promise.all(specs.map(async([kind,url,payload])=>{
    const start=Date.now();
    try{
      const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify(payload),redirect:'manual',signal:AbortSignal.timeout(30000)});
      const headers=Object.fromEntries(allowedHeaders.flatMap(key=>response.headers.has(key)?[[key,response.headers.get(key)]]:[]));
      // Inspect a bounded response in memory. Never return or save raw HTML, cookies or tokens.
      const reader=response.body?.getReader(),chunks=[];let bytes=0,truncated=false;
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;
        if(bytes>65536){truncated=true;break;}chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
      const body=Buffer.concat(chunks),text=body.toString('utf8');
      const digest=await crypto.subtle.digest('SHA-256',body);
      const sha256=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
      return {kind,endpoint:new URL(url).pathname,http_status:response.status,headers,body_bytes:bytes,truncated,
        body_sha256:sha256,body_fingerprint:response.ok?{format:/json/i.test(headers['content-type']||'')?'json':'other'}:fingerprint(text),duration_ms:Date.now()-start};
    }catch(error){return {kind,error_name:error.name,error_code:error.cause?.code||null,duration_ms:Date.now()-start};}
  }));
  const result={run_id:runId,observed_at,query,requests:specs.length,results};
  console.log(JSON.stringify({event:'vna_diagnostic_complete',...result}));
  return result;
}
