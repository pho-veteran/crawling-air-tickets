import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../scripts/lib/local-d1.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import {requestFeedRefresh,DISPATCH_KEY,DISPATCH_INTERVAL_MS} from '../src/worker/vna-feed-dispatch.mjs';

test('Worker dispatch is opt-in and skips a recently received feed',async()=>{
  const store={now:()=>Date.now(),statement:()=>assert.fail('must not write')};
  assert.equal((await requestFeedRefresh({store,env:{}})).state,'disabled');
  assert.equal((await requestFeedRefresh({store,env:{GITHUB_ACTIONS_TOKEN:'secret'},record:{observed_at:new Date().toISOString()}})).state,'fresh');
});
test('cron and command callers share a durable ten-minute dispatch budget and fixed repository target',async t=>{
  const db=new LocalD1();await db.migrate();t.after(()=>db.close());
  let now=Date.now(),calls=0;const store=new RuntimeStore(db,{now:()=>now}),env={GITHUB_ACTIONS_TOKEN:'PRIVATE'};
  const fetchImpl=async(url,options)=>{calls++;
    assert.equal(url,'https://api.github.com/repos/pho-veteran/crawling-air-tickets/actions/workflows/vna-agency-feed.yml/dispatches');
    assert.equal(options.headers.authorization,'Bearer PRIVATE');assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{dry_run:'false'}});
    return calls===1?Response.json({workflow_run_id:123}):new Response(null,{status:204});};
  const requests=await Promise.all(Array.from({length:5},()=>requestFeedRefresh({store,env,fetchImpl})));
  assert.equal(calls,1);assert.equal(requests.filter(r=>r.state==='accepted').length,1);
  assert.doesNotMatch(JSON.stringify(await store.state(DISPATCH_KEY)),/PRIVATE/);
  now+=DISPATCH_INTERVAL_MS-1;assert.equal((await requestFeedRefresh({store,env,fetchImpl})).state,'throttled');
  now++;assert.equal((await requestFeedRefresh({store,env,fetchImpl})).state,'accepted');assert.equal(calls,2);
});
test('rejected and ambiguous dispatches retain cooldown without leaking upstream data',async t=>{
  const db=new LocalD1();await db.migrate();t.after(()=>db.close());
  let now=Date.now();const store=new RuntimeStore(db,{now:()=>now}),env={GITHUB_ACTIONS_TOKEN:'PRIVATE'};
  assert.deepEqual(await requestFeedRefresh({store,env,fetchImpl:async()=>new Response('PRIVATE',{status:401})}),{state:'rejected',http:401});
  assert.equal((await requestFeedRefresh({store,env,fetchImpl:()=>assert.fail('cooldown')})).state,'throttled');
  now+=DISPATCH_INTERVAL_MS;
  assert.deepEqual(await requestFeedRefresh({store,env,fetchImpl:async()=>{throw new Error('PRIVATE');}}),{state:'network_error',http:null});
  assert.doesNotMatch(JSON.stringify(await store.state(DISPATCH_KEY)),/PRIVATE/);
});
