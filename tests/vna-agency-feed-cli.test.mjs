import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
const execute=promisify(execFile),runner=fileURLToPath(new URL('../scripts/vna-agency-feed.mjs',import.meta.url));
const fixtures=new URL('../scripts/fixtures/agencies.mjs',import.meta.url).href,config=new URL('../config.json',import.meta.url).href,core=new URL('../src/providers/vna-core.mjs',import.meta.url).href;
test('official runner dry-run never delivers, source failures never publish, and delivery failures fail the run',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'official-vna-feed-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const preload=path.join(folder,'source.mjs');
  await writeFile(preload,`import {simulatedSources} from ${JSON.stringify(fixtures)};import config from ${JSON.stringify(config)} with {type:'json'};import {queryFrom} from ${JSON.stringify(core)};
const source=simulatedSources(queryFrom(config)),mode=process.env.TEST_OUTCOME;
globalThis.fetch=async(url,options={})=>{
 if(new URL(url).hostname.endsWith('.workers.dev')){if(process.argv.includes('--dry-run'))throw new Error('Dry run delivered');if(mode==='source-error')throw new Error('Failed source delivered');return new Response(null,{status:mode==='delivery-error'?503:202});}
 if(mode==='source-error')return new Response(null,{status:503});return source.fetch(url,options);
};`);
  for(const [mode,dry,code] of [['ok',true,0],['ok',false,0],['source-error',false,1],['delivery-error',false,1]])await t.test(mode+(dry?' dry':''),async()=>{
    let result,actual=0;try{result=await execute(process.execPath,['--import',pathToFileURL(preload).href,runner,...(dry?['--dry-run']:[])],{env:{...process.env,TEST_OUTCOME:mode,VNA_FEED_SECRET:'test'},timeout:15000});}catch(error){result=error;actual=error.code;}
    assert.equal(actual,code,result.stderr);
    assert.equal(result.stdout.includes('official_vna_feed_delivered'),mode==='ok'&&!dry);
  });
});
