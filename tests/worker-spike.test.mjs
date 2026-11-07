import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{probe} from '../src/worker/spike.mjs';

test('remote probe requires a secret; health and rejected calls never crawl',async()=>{
  assert.equal((await worker.fetch(new Request('https://example.test/health'),{})).status,200);
  for(const env of [{},{PROBE_SECRET:'expected'}]) {
    const response=await worker.fetch(new Request('https://example.test/probe',{method:'POST'}),env);
    assert.equal(response.status,401);
  }
  assert.equal((await worker.fetch(new Request('https://example.test/probe'),{})).status,404);
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
