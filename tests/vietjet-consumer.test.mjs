import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {crawl,SOURCE} from '../src/providers/vietjet.mjs';
import {queryFrom,queryId} from '../src/providers/vna.mjs';
import {readHistory} from '../src/reporting/history.mjs';
import {simulatedSources} from '../scripts/fixtures/agencies.mjs';
const q=queryFrom({origin:'SGN',destination:'VCL',departureDate:'2027-02-04',returnDate:'2027-02-13',adults:1});

test('separate selected-date searches retain each fare and roundtrip sum',async()=>{
  const source=simulatedSources(q),r=await crawl(q,{fetchImpl:source.fetch});
  assert.equal(r.status,'ok');assert.equal(r.main_price,4200000);assert.equal(r.cells[0].price,4200000);
  for(const [leg,price] of [['outbound',1800000],['inbound',2400000]]){
    const f=r.legs[leg][0].flights[0];assert.equal(f.price,price);assert.equal(f.ota_price-f.price,50000);
    assert.equal(f.stops,0);assert.equal(f.segments.length,1);assert.equal(f.total_duration_minutes,80);
  }
});
test('HTTP failures do not schedule neighboring dates',async()=>{
  for(const status of [403,429,503])await assert.rejects(crawl(q,{fetchImpl:async()=>new Response('',{status})}),new RegExp('HTTP '+status));
});
test('old Flynow and calendar histories are isolated by the new source identity',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'vietjet-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const record=await crawl(q,{fetchImpl:simulatedSources(q).fetch});
  const older=['vietjet-public-calendar-v1','vietjet-flynow-selected-flight-fares-v2'].map(source=>({...record,source,query_id:queryId(q,source),main_price:5660000}));
  const file=path.join(dir,'history.jsonl');await writeFile(file,[...older,record].map(x=>JSON.stringify(x)).join('\n'));
  assert.deepEqual((await readHistory(file,q,SOURCE)).map(x=>x.main_price),[4200000]);
});
