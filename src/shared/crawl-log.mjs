import {appendFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {channel} from 'node:diagnostics_channel';
import {randomUUID} from 'node:crypto';

const active=new AsyncLocalStorage(),requests=new WeakMap();
// Do not persist headers, cookies, bodies, query strings, tokens or error messages
// which can embed them. Error names/codes and nested causes are enough for transport diagnostics.
const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(value)?value:undefined;
export function errorInfo(error){
  const result=[];let current=error;
  for(let i=0;current&&i<4;i++,current=current.cause)result.push({name:safe(current.name),code:typeof current.code==='number'?current.code:safe(current.code)});
  return result;
}
function observe(name,handler){channel(name).subscribe(message=>{try{handler(message);}catch{/* diagnostics must not interrupt a request */}});}
observe('undici:request:create',({request})=>{const trace=active.getStore();if(trace)requests.set(request,trace);});
observe('undici:client:sendHeaders',({request,socket})=>{
  const t=requests.get(request);if(!t)return;
  t.phase='sending_request';t.emit('request_connected',{remote_address:socket.remoteAddress,tls_authorized:socket.encrypted?socket.authorized:undefined});
});
observe('undici:request:bodySent',({request})=>{const t=requests.get(request);if(t){t.phase='waiting_response_headers';t.emit('request_sent');}});
observe('undici:request:headers',({request,response})=>{const t=requests.get(request);if(t){t.phase='reading_response_body';t.status=response.statusCode;t.emit('response_headers',{http_status:response.statusCode});}});
observe('undici:request:trailers',({request})=>{const t=requests.get(request);if(t){t.phase='complete';t.emit('response_complete',{http_status:t.status});}});
observe('undici:request:error',({request,error})=>{const t=requests.get(request);if(t)t.emit('transport_error',{phase:t.phase,errors:errorInfo(error),http_status:t.status});});

export function createCrawlLog(root,{runId=randomUUID(),write,now=Date.now}={}){
  let warned=false;
  const emit=event=>{
    const at=new Date(now()).toISOString(),row={at,run_id:runId,pid:process.pid,...event};
    try{
      if(write)write(row);
      else{
        const dir=path.join(root,'data');mkdirSync(dir,{recursive:true});
        appendFileSync(path.join(dir,'crawl-'+at.slice(0,10)+'.jsonl'),JSON.stringify(row)+'\n');
      }
    }catch{if(!warned){warned=true;console.error('CRAWL_LOG_WRITE_FAILED: không ghi được log chẩn đoán.');}}
  };
  function traceFetch(source,fetchImpl=fetch){
    let count=0;const summaries=[];
    const traced=async(url,options={})=>{
      const endpoint=new URL(url),start=now(),id=source+'-'+(++count);
      const summary={request_id:id,endpoint:endpoint.origin+endpoint.pathname,method:options.method||'GET',phase:'connecting_or_queued'};
      // Public VNA route fields distinguish the two calls to air-best-price.
      if(source==='vna'&&typeof options.body==='string')try{
        const route=JSON.parse(options.body).route;
        if(route&&/^[A-Z]{3}$/.test(route.originLocationCode)&&/^[A-Z]{3}$/.test(route.destinationLocationCode))summary.route=route.originLocationCode+'-'+route.destinationLocationCode;
      }catch{}
      summaries.push(summary);
      const trace={phase:summary.phase,emit:(event,fields={})=>{
        summary.phase=trace.phase;summary.duration_ms=now()-start;
        if(trace.status!==undefined)summary.http_status=trace.status;
        emit({event,source,...summary,...fields});
      }};
      trace.emit('request_start');
      return active.run(trace,async()=>{
        try{
          const response=await fetchImpl(url,options);
          trace.status=response.status;summary.http_status=response.status;
          trace.emit('fetch_resolved',{content_type:response.headers.get('content-type')?.slice(0,100)});
          return response;
        }catch(error){summary.errors=errorInfo(error);trace.emit('request_failed',{errors:summary.errors});throw error;}
      });
    };
    return {fetch:traced,summaries,get count(){return count;}};
  }
  return {runId,emit,traceFetch};
}
