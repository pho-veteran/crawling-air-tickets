import {timingSafeEqual} from 'node:crypto';
import config from '../../config.json' with {type:'json'};
import {queryFrom} from '../providers/vna-core.mjs';
import {crawl as vna} from '../providers/vna-flynow.mjs';
import {crawl as vietjet} from '../providers/vietjet-flynow.mjs';
import {storageCheck} from './storage-check.mjs';
import {diagnose} from './vna-diagnostic.mjs';
import {crawl as agencies} from '../providers/vna-agencies.mjs';

const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
function authorized(request,env) {
  if (!env.PROBE_SECRET) return false;
  const supplied=new TextEncoder().encode(request.headers.get('authorization')||'');
  const expected=new TextEncoder().encode('Bearer '+env.PROBE_SECRET);
  return supplied.length===expected.length && timingSafeEqual(supplied,expected);
}
export async function probe({fetchImpl=fetch,runId=crypto.randomUUID(),sources=['vna','vietjet']}={}) {
  const started=Date.now(),query=queryFrom(config),diagnostics=[];
  const run=async(source,crawl)=>{
    let requests=0;
    const tracedFetch=async(url,options)=>{
      const requestId=runId+':'+source+':'+(++requests),begin=Date.now();
      const emit=entry=>{const event={run_id:runId,request_id:requestId,source,...entry};diagnostics.push(event);console.log(JSON.stringify(event));};
      emit({event:'request_started',endpoint:new URL(url).pathname});
      try {
        // Workers do not implement redirect:'error'. Manual mode still prevents
        // following redirects; the provider rejects any non-2xx response.
        const response=await fetchImpl(url,{...options,redirect:options.redirect==='error'?'manual':options.redirect});
        emit({event:'response_headers',http_status:response.status,duration_ms:Date.now()-begin});
        const reader=response.body?.getReader();let bytes=0,canceled=false;
        const body=reader?new ReadableStream({
          async pull(controller){
            try {const {done,value}=await reader.read();if(canceled)return;if(done){emit({event:'response_complete',bytes,duration_ms:Date.now()-begin});controller.close();}else{bytes+=value.byteLength;controller.enqueue(value);}}
            catch(error){if(canceled)return;emit({event:'response_error',error_name:error.name,duration_ms:Date.now()-begin});controller.error(error);}
          },
          cancel(reason){canceled=true;emit({event:'response_cancelled',bytes,duration_ms:Date.now()-begin});return reader.cancel(reason);},
        }):null;
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      } catch(error) {
        emit({event:'request_error',error_name:error.name,error_code:error.cause?.code||null,duration_ms:Date.now()-begin});
        throw error;
      }
    };
    try {return {source,snapshot:await crawl(query,{fetchImpl:tracedFetch}),requests};}
    catch(error){return {source,status:'error',error:String(error.message).slice(0,350),requests};}
  };
  const available={vna,vietjet};
  const results=await Promise.all(sources.map(source=>run(source,available[source])));
  const result={run_id:runId,observed_at:new Date().toISOString(),query,results,diagnostics,
    wall_ms:Date.now()-started,requests:results.reduce((n,r)=>n+r.requests,0)};
  console.log(JSON.stringify({event:'probe_complete',run_id:runId,wall_ms:result.wall_ms,requests:result.requests,
    results:results.map(r=>({source:r.source,status:r.snapshot?.status||r.status,main_price:r.snapshot?.main_price??null,
      priced_cells:r.snapshot?.cells.filter(c=>c.price!==null).length??0,response_bytes:r.snapshot?.response_bytes??null,error:r.error||null}))}));
  return result;
}
export default {
  async fetch(request,env) {
    const pathname=new URL(request.url).pathname;
    if(pathname==='/health'&&request.method==='GET')return json({ok:true,service:'air-ticket-feasibility-probe'});
    if(!['/probe','/probe-queue','/storage-check','/vna-diagnostic','/agency-probe'].includes(pathname)||request.method!=='POST')return json({error:'Not found'},404);
    if(!authorized(request,env))return json({error:'Unauthorized'},401);
    if(pathname==='/agency-probe'){
      try{return json(await agencies(queryFrom(config)));}
      catch(e){return json({status:'error',error:e.message,requests:e.requests||0,agency_quotes:e.agency_quotes},502);}
    }
    if(pathname==='/vna-diagnostic')return json(await diagnose());
    if(pathname==='/probe-queue'||pathname==='/storage-check') {
      const run_id=crypto.randomUUID();
      const source=pathname==='/storage-check'?'storage':'both';
      try {await env.PROBE_QUEUE.send({run_id,source});}
      catch {return json({error:'Queue persistence failed'},503);}
      return json({run_id,status:'queued',source},202);
    }
    return json(await probe());
  },
  async queue(batch,env) {
    for(const message of batch.messages) {
      if(message.body.source==='storage'){
        try {await storageCheck(env.STORAGE_CHECK,message.body.run_id);}
        catch(error){console.log(JSON.stringify({event:'storage_check_failed',run_id:message.body.run_id,error:String(error.message).slice(0,300)}));throw error;}
        message.ack();continue;
      }
      // One selected-date search per airline, without automatic source retries.
      if(!['both','vietjet'].includes(message.body.source)){message.ack();continue;}
      await probe({runId:message.body.run_id,sources:message.body.source==='both'?['vna','vietjet']:['vietjet']});
      message.ack();
    }
  },
};
