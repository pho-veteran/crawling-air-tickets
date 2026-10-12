import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createCrawlLog,errorInfo} from '../src/shared/crawl-log.mjs';
import {crawl as crawlVna} from '../src/providers/vna.mjs';

test('real fetch tracing identifies waiting headers, body errors and HTTP rejection without leaking secrets',async t=>{
  let arrived;
  const server=createServer((req,res)=>{
    if(req.url.startsWith('/hang')){arrived();return;}
    if(req.url.startsWith('/body')){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');return;}
    res.writeHead(403,{'Content-Type':'text/html','Set-Cookie':'PRIVATE_COOKIE'});res.end('PRIVATE_BODY');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const rows=[],log=createCrawlLog('unused',{write:r=>rows.push(r)}),trace=log.traceFetch('vna');
  const base='http://127.0.0.1:'+server.address().port;
  const ready=new Promise(r=>arrived=r),controller=new AbortController();
  const hanging=trace.fetch(base+'/hang?token=PRIVATE_QUERY',{method:'POST',headers:{Authorization:'PRIVATE_AUTH'},body:'PRIVATE_REQUEST',signal:controller.signal});
  await ready;controller.abort(new DOMException('PRIVATE_ERROR','TimeoutError'));
  await assert.rejects(hanging,{name:'TimeoutError'});
  const fail=rows.find(r=>r.event==='request_failed');
  assert.equal(fail.phase,'waiting_response_headers');assert.equal(fail.errors[0].name,'TimeoutError');assert.equal(trace.count,1);
  const denied=await trace.fetch(base+'/denied');await denied.text();
  assert.ok(rows.some(r=>r.event==='response_headers'&&r.http_status===403));
  assert.ok(rows.some(r=>r.event==='response_complete'&&r.http_status===403));
  const bodyAbort=new AbortController(),body=await trace.fetch(base+'/body',{signal:bodyAbort.signal});
  bodyAbort.abort();await assert.rejects(body.text());
  assert.ok(rows.some(r=>r.event==='transport_error'&&r.phase==='reading_response_body'));
  assert.equal(trace.count,3);
  assert.ok(rows.every(r=>r.run_id===log.runId&&Number.isFinite(r.duration_ms)));
  assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_|Authorization|Set-Cookie|token=/);
});

test('trace retains nested transport codes and logging failure never changes fetch result',async()=>{
  const e=Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('private host'),{code:'ECONNRESET'})});
  assert.deepEqual(errorInfo(e),[{name:'TypeError',code:undefined},{name:'Error',code:'ECONNRESET'}]);
  const rows=[],trace=createCrawlLog('unused',{write:r=>rows.push(r)}).traceFetch('vna',async()=>{throw e;});
  await assert.rejects(trace.fetch('https://example.test/api'),e);assert.equal(trace.count,1);
  assert.equal(rows.at(-1).errors[1].code,'ECONNRESET');
  const previous=console.error;let warnings=0;console.error=()=>warnings++;
  try{
    const failing=createCrawlLog('unused',{write:()=>{throw new Error('disk');}}).traceFetch('vna',async()=>new Response('ok'));
    assert.equal(await(await failing.fetch('https://example.test/api')).text(),'ok');assert.equal(warnings,1);
  }finally{console.error=previous;}
});

test('failed VNA matrix waits for remaining endpoints before crawl completion',async()=>{
  const q={origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1};
  let release,finished=false,count=0;
  const gate=new Promise(r=>release=r);
  const pending=crawlVna(q,{fetchImpl:async url=>{count++;if(url.endsWith('fare-matrix'))throw new Error('matrix failed');await gate;return new Response('',{status:503});}});
  const checked=assert.rejects(pending,/matrix failed/).then(()=>{finished=true;});
  await new Promise(r=>setImmediate(r));assert.equal(count,3);assert.equal(finished,false);
  release();await checked;
});
