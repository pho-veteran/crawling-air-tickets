import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{probe} from '../src/worker/spike.mjs';
import config from '../config.json' with {type:'json'};
import {simulatedFlynow} from '../scripts/fixtures/flynow.mjs';

test('remote probe requires a secret; health and rejected calls never crawl',async()=>{
  assert.equal((await worker.fetch(new Request('https://example.test/health'),{})).status,200);
  for(const env of [{},{PROBE_SECRET:'expected'}]) {
    const response=await worker.fetch(new Request('https://example.test/probe',{method:'POST'}),env);
    assert.equal(response.status,401);
  }
  assert.equal((await worker.fetch(new Request('https://example.test/probe'),{})).status,404);
});
test('portable probe gets flight quotes from both agencies for selected dates only',async()=>{
  const flynow=simulatedFlynow(config);
  const fetchImpl=async(url,options)=>{
    assert.equal(options.redirect,'manual');
    assert.ok(url.includes('flynow'));
    return flynow.fetch(url,options);
  };
  const result=await probe({fetchImpl,runId:'fixture-run'});
  assert.equal(result.requests,2);
  assert.equal(result.results[0].snapshot.main_price,2400000);
  assert.equal(result.results[1].snapshot.main_price,2400000);
  for(const r of result.results){assert.equal(r.snapshot.status,'ok');assert.equal(r.snapshot.cells.length,0);}
  assert.equal(result.results[0].snapshot.supplier_system,'EVN');
  assert.equal(result.results[1].snapshot.supplier_system,'EVJ');
  assert.equal(result.diagnostics.filter(d=>d.event==='response_complete').length,2);
  assert.doesNotMatch(JSON.stringify(result),/Session|Token|FlightValue/);
});
test('blocked sources remain errors with actual attempts, never zero-price snapshots',async()=>{
  const result=await probe({fetchImpl:async()=>new Response('',{status:403}),runId:'blocked-fixture'});
  assert.equal(result.requests,2);
  assert.ok(result.results.every(r=>r.status==='error'&&/HTTP 403/.test(r.error)));
  assert.ok(result.results.every(r=>!r.snapshot));
  assert.ok(result.diagnostics.every(d=>d.event!=='response_error'));
});
test('queue probe ACK follows durable enqueue; failed enqueue returns a retryable response',async()=>{
  let release,job;const gate=new Promise(r=>release=r);
  const request=()=>new Request('https://example.test/probe-queue',{method:'POST',headers:{authorization:'Bearer expected'}});
  let returned=false;
  const pending=worker.fetch(request(),{PROBE_SECRET:'expected',PROBE_QUEUE:{async send(body){job=body;await gate;}}}).then(r=>{returned=true;return r;});
  await new Promise(r=>setImmediate(r));assert.equal(returned,false);assert.equal(job.source,'both');
  release();const response=await pending;assert.equal(response.status,202);assert.equal((await response.json()).run_id,job.run_id);
  const failed=await worker.fetch(request(),{PROBE_SECRET:'expected',PROBE_QUEUE:{async send(){throw new Error('unavailable');}}});
  assert.equal(failed.status,503);
});
