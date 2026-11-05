import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const execute=promisify(execFile);
const runner=fileURLToPath(new URL('../scripts/vna-agency-feed.mjs',import.meta.url));
const fixtures=new URL('../scripts/fixtures/agencies.mjs',import.meta.url).href;
const config=new URL('../config.json',import.meta.url).href;
const core=new URL('../src/providers/vna-core.mjs',import.meta.url).href;

test('Actions distinguishes completed no-fare searches from crawl and delivery failures',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'agency-feed-cli-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const preload=path.join(folder,'source.mjs');
  await writeFile(preload,`
import {simulatedSources} from ${JSON.stringify(fixtures)};
import config from ${JSON.stringify(config)} with {type:'json'};
import {queryFrom} from ${JSON.stringify(core)};
const source=simulatedSources(queryFrom(config));
const mode=process.env.TEST_AGENCY_OUTCOME;
globalThis.fetch=async(url,options={})=>{
  const u=new URL(url);
  if(u.hostname.endsWith('.workers.dev')){
    if(process.argv.includes('--dry-run'))throw new Error('Dry-run must not deliver a feed');
    return new Response(null,{status:mode==='delivery-error'?503:202});
  }
  if(mode==='both-errors'||['crawl-error','empty-and-error'].includes(mode)&&u.hostname==='www.bestprice.vn')
    return new Response(null,{status:503});
  if(mode==='abay-error'&&u.pathname.endsWith('/GetFlights'))return Response.json({d:'{}'});
  if(mode==='schema-errors'){
    if(u.pathname==='/ajax-search-flight-bp')return Response.json({search_status:'DONE',search_data:{}});
    if(u.pathname.endsWith('/GetFlights'))return Response.json({d:'{}'});
  }
  const response=await source.fetch(url,options);
  if(['both-empty','delivery-error','bestprice-empty','empty-and-error'].includes(mode)){
    if(u.pathname==='/ajax-search-flight-bp')return Response.json({search_status:'DONE',search_data:{flight_data:[]}});
    if(mode!=='bestprice-empty'&&u.pathname.endsWith('/GetFlights'))return Response.json({d:JSON.stringify({D:[]})});
  }
  return response;
};
`);
  for(const {mode,dry=false,exit,status,agencies,delivered} of [
    {mode:'bestprice-empty',exit:0,status:'ok',agencies:{ABAY:'ok',BestPrice:'empty'},delivered:true},
    {mode:'both-empty',exit:0,status:'partial',agencies:{ABAY:'empty',BestPrice:'empty'},delivered:true},
    {mode:'both-empty',dry:true,exit:0,status:'partial',agencies:{ABAY:'empty',BestPrice:'empty'},delivered:false},
    {mode:'crawl-error',exit:0,status:'partial',agencies:{ABAY:'ok',BestPrice:'error'},delivered:true},
    {mode:'abay-error',exit:0,status:'partial',agencies:{ABAY:'error',BestPrice:'ok'},delivered:true},
    {mode:'crawl-error',dry:true,exit:0,status:'partial',agencies:{ABAY:'ok',BestPrice:'error'},delivered:false},
    {mode:'empty-and-error',exit:0,status:'partial',agencies:{ABAY:'empty',BestPrice:'error'},delivered:true},
    {mode:'both-errors',exit:1,delivered:false},
    {mode:'schema-errors',exit:1,delivered:false},
    {mode:'delivery-error',exit:1,status:'partial',agencies:{ABAY:'empty',BestPrice:'empty'},delivered:false},
  ])await t.test(mode+(dry?' dry-run':''),async()=>{
    const env={...process.env,GITHUB_ACTIONS:'true',TEST_AGENCY_OUTCOME:mode,VNA_FEED_SECRET:'test-feed-secret'};
    if(dry)delete env.VNA_FEED_SECRET;
    let result,code=0;
    try{result=await execute(process.execPath,['--import',pathToFileURL(preload).href,runner,...(dry?['--dry-run']:[])],{env,timeout:15000,windowsHide:true});}
    catch(error){result=error;code=error.code;}
    assert.equal(code,exit,result.stderr);
    const events=result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(events.some(e=>e.event==='agency_feed_delivered'),delivered);
    if(status){
      const complete=events.find(e=>e.event==='agency_crawl_complete');
      assert.equal(complete.status,status);
      assert.deepEqual(Object.fromEntries(complete.agencies.map(q=>[q.agency,q.status])),agencies);
      if(Object.values(agencies).includes('error'))assert.match(result.stderr,/::warning/);
    }
    if(mode==='delivery-error')assert.match(result.stderr,/Agency feed delivery HTTP 503/);
    if(['both-errors','schema-errors'].includes(mode))assert.match(result.stderr,/BestPrice and ABAY searches unavailable/);
  });
});
