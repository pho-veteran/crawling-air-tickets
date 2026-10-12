import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBatch} from '../src/shared/batch.mjs';
import {normalizeOneWay,oneWayRequest} from '../src/providers/vna-oneway.mjs';
const temp=()=>mkdtemp(path.join(os.tmpdir(),'fare-batch-test-'));
test('retrieval fires immediately with no pacing, budget or fill-up sleep',async()=>{
  let clock=0;const starts=[],root=await temp();
  const batch=await createBatch({root,now:()=>clock,sleep:async()=>{throw new Error('Must not sleep');},
    fetchImpl:async(url,opts)=>{starts.push(clock);clock+=1000;return new Response('{}');}});
  await Promise.all([0,1,2,3,4].map(()=>batch.fetch('https://example.test/calendar')));
  assert.deepEqual(starts,[0,1000,2000,3000,4000]);
  assert.equal(batch.requests,5);
  const summary=await batch.finish();
  assert.equal(summary.requests,5);assert.equal(summary.budget_seconds,null);
});
test('http errors no longer park sources; the next retrieval retries immediately',async()=>{
  const failing=await createBatch({fetchImpl:async()=>new Response('',{status:429})});
  await failing.fetch('https://example.test/calendar');
  const retry=await createBatch({fetchImpl:async()=>new Response('{}')});
  await retry.fetch('https://example.test/other');assert.equal(retry.requests,1);
  await retry.fetch('https://other.test/calendar');assert.equal(retry.requests,2);
});
test('one-way normalizer preserves taxes and dates; never accepts roundtrip or fills missing prices',()=>{
  const dates=['2027-02-04','2027-02-05'],entry={departureDate:dates[0],price:[{base:'3996000',totalTaxes:'1337181',total:'5333181',currencyCode:'VND'}]};
  const payload={success:true,data:{prices:[entry],dictionaries:{currency:{VND:{decimalPlaces:0}}}}};
  const legs=normalizeOneWay(payload,dates,'2026-10-11T16:00:00Z');assert.equal(legs[0].price,5333181);assert.equal(legs[0].taxes,1337181);assert.equal(legs[1].price,null);
  assert.equal(oneWayRequest('SGN','VCL',dates).tripDetails.tripDuration,undefined);
  entry.returnDate='2027-02-13';assert.throws(()=>normalizeOneWay(payload,dates),/khứ hồi/);delete entry.returnDate;
  entry.price[0].total='5333182';assert.throws(()=>normalizeOneWay(payload,dates),/không hợp lệ/);
});
