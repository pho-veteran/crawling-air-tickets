import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {projectRoot} from '../src/shared/paths.mjs';
import {D1Repository,digest} from '../src/storage/d1.mjs';
import {importFiles,planImport,applyImport} from '../src/storage/import.mjs';
import {LocalD1} from './lib/local-d1.mjs';

const {values:args}=parseArgs({options:{snapshot:{type:'boolean',default:false}}});
const sourceDir=path.join(projectRoot,'data'),inputs={};
for(const name of importFiles) {
  try {const bytes=await readFile(path.join(sourceDir,name));inputs[name]={text:bytes.toString('utf8'),hash:digest(bytes),bytes};}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
const plan=planImport(inputs);
let outputDir;
if(args.snapshot) {
  outputDir=path.join(sourceDir,'cloudflare-import-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  await mkdir(outputDir);
  for(const [name,input] of Object.entries(inputs))await writeFile(path.join(outputDir,name),input.bytes,{flag:'wx'});
}
const db=new LocalD1(outputDir?path.join(outputDir,'import.sqlite'):':memory:');
try {
  await db.migrate();const repository=new D1Repository(db);
  const first=await applyImport(repository,plan),repeated=await applyImport(repository,plan);
  if(repeated.insertedObservations!==0)throw new Error('Repeated import duplicated history.');
  // Validate both present and absent files across the entire capture/import.
  for(const name of importFiles) {
    let current;
    try {current=digest(await readFile(path.join(sourceDir,name)));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(current!==inputs[name]?.hash)throw new Error('Source data changed during validation; retry after a stable snapshot.');
  }
  const report={observed_at:new Date().toISOString(),mode:args.snapshot?'local-backup-and-sqlite':'memory-dry-run',
    backend:'Node SQLite (not remote D1)',verified:first.verified,summary:first.summary,
    inserted:first.insertedObservations,repeatedInserted:repeated.insertedObservations,
    files:Object.fromEntries(Object.entries(inputs).map(([name,input])=>[name,{sha256:input.hash,bytes:input.bytes.length}])),
    rawStatePreserved:true,liveOutboxTranslation:'pending',remoteImport:'not_performed',productionCutover:'not_performed'};
  const filename=outputDir?path.join(outputDir,'manifest.json'):path.join(sourceDir,'cloudflare-import-validation.json');
  await writeFile(filename,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,report:filename},null,2));
} catch(error) {
  if(outputDir)await writeFile(path.join(outputDir,'FAILED.json'),JSON.stringify({verified:false,error:'Import validation failed; inspect inputs without changing production data.'})+'\n');
  throw error;
} finally {db.close();}
