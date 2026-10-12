import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBatch} from '../src/shared/batch.mjs';
import {normalizeOneWay,oneWayRequest} from '../src/providers/vna-oneway.mjs';
const temp=()=>mkdtemp(path.join(os.tmpdir(),'fare-batch-test-'));
test('five requests are spaced 18s and batch finishes at 90s without real sleep',async()=>{
  let clock=0;const starts=[],root=await temp();
  const batch=await createBatch({root,now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,opts)=>{assert.equal(opts.signal.aborted,false);starts.push(clock);clock+=1000;return new Response('{}');}});
  for(let i=0;i<5;i++)await batch.fetch('https://example.test/calendar');
  assert.deepEqual(starts,[0,18000,36000,54000,72000]);
  assert.deepEqual(await batch.finish(),{duration_ms:90000,requests:5,budget_seconds:90});
});
test('429 cooldown survives restart, respects Retry-After and leaves other hosts available',async()=>{
  let clock=1000000;const root=await temp();
  const options={root,now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async()=>new Response('',{status:429,headers:{'Retry-After':'7200'}})};
  const first=await createBatch(options);await first.fetch('https://example.test/calendar');
  const second=await createBatch({...options,fetchImpl:async()=>new Response('{}')});
  await assert.rejects(second.fetch('https://example.test/other'),/Nguồn đang nghỉ/);assert.equal(second.requests,0);
  await second.fetch('https://other.test/calendar');assert.equal(second.requests,1);
  clock+=7200001;const third=await createBatch({...options,fetchImpl:async()=>new Response('{}')});await third.fetch('https://example.test/calendar');
});
test('expired budget never sends another request',async()=>{
  let clock=0;const root=await temp(),batch=await createBatch({root,now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async()=>new Response('{}')});
  clock=90001;await assert.rejects(batch.fetch('https://example.test/'),/Hết ngân sách/);assert.equal(batch.requests,0);
});
test('one-way normalizer preserves taxes and dates; never accepts roundtrip or fills missing prices',()=>{
  const dates=['2027-02-04','2027-02-05'],entry={departureDate:dates[0],price:[{base:'3996000',totalTaxes:'1337181',total:'5333181',currencyCode:'VND'}]};
  const payload={success:true,data:{prices:[entry],dictionaries:{currency:{VND:{decimalPlaces:0}}}}};
  const legs=normalizeOneWay(payload,dates,'2026-10-11T16:00:00Z');assert.equal(legs[0].price,5333181);assert.equal(legs[0].taxes,1337181);assert.equal(legs[1].price,null);
  assert.equal(oneWayRequest('SGN','VCL',dates).tripDetails.tripDuration,undefined);
  entry.returnDate='2027-02-13';assert.throws(()=>normalizeOneWay(payload,dates),/khứ hồi/);delete entry.returnDate;
  entry.price[0].total='5333182';assert.throws(()=>normalizeOneWay(payload,dates),/không hợp lệ/);
});
