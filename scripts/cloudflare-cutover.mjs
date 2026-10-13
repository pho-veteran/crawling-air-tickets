import {readFile,writeFile,access} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {worker,secrets,workerUrl} from './lib/worker-api.mjs';
import {telegram} from '../src/worker/telegram.mjs';
const exec=promisify(execFile),root=process.cwd(),oldPids=[];
const current=await worker('/health');if(!current.ok||current.active)throw new Error('Expected a healthy inactive Worker before cutover.');
const preflight=JSON.parse(await readFile('data/worker-runtime-preflight.json','utf8'));
if(preflight.sources.some(p=>p.status!=='ok'))throw new Error('Source gate failed.');
const s=await secrets(),hook=await telegram(s,'getWebhookInfo',{});if(hook.url&&hook.url!==workerUrl+'/telegram')throw new Error('Unexpected existing webhook.');
for(const file of ['watch.lock','bot.lock','run.lock','daily.lock'])try{oldPids.push(JSON.parse(await readFile(path.join(root,'data',file),'utf8')).pid);}catch{}
// Graceful stop belongs to this repository only. No global process sweep or forced deletion.
await writeFile(path.join(root,'data','watch.stop'),'Cloudflare cutover');
console.log('Waiting for this repository watcher and children to finish before final capture.');
const until=Date.now()+180000;
while(Date.now()<until){
  let busy=false;
  for(const file of ['watch.lock','bot.lock','run.lock','daily.lock'])try{await access(path.join(root,'data',file));busy=true;}catch{}
  if(!busy)break;await new Promise(r=>setTimeout(r,1000));
}
for(const file of ['watch.lock','bot.lock','run.lock','daily.lock'])try{await access(path.join(root,'data',file));throw new Error('Local lock did not clear: '+file);}catch(error){if(error.code!=='ENOENT')throw error;}
for(const pid of oldPids){let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw new Error('Local process still alive; no activation performed.');}
let backup;
try{
  const capture=await exec(process.execPath,['scripts/cloudflare-import.mjs','--snapshot'],{windowsHide:true,maxBuffer:4*1024*1024});
  const manifest=JSON.parse(capture.stdout);backup=path.dirname(manifest.report);
  await writeFile('data/worker-cutover-backup.json',JSON.stringify({folder:backup,stopped_pids:oldPids,stopped_at:new Date().toISOString()})+'\n');
  console.log('Local watcher stopped; verified final backup captured. Importing to D1.');
  const imported=await exec(process.execPath,['--dns-result-order=ipv4first','scripts/cloudflare-runtime.mjs','--import',backup],{windowsHide:true,maxBuffer:4*1024*1024});process.stdout.write(imported.stdout);
  const activated=await exec(process.execPath,['--dns-result-order=ipv4first','scripts/cloudflare-runtime.mjs','--activate'],{windowsHide:true,maxBuffer:4*1024*1024});process.stdout.write(activated.stdout);
  const health=await worker('/health');if(!health.active||!health.ok)throw new Error('Activation health failed.');
  const result={completed_at:new Date().toISOString(),worker:workerUrl,active:true,local_watcher_stopped:true,old_pids:oldPids,backup};
  await writeFile('data/worker-cutover-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}catch(error){
  await worker('/admin/activate',{method:'POST',body:{active:false}}).catch(()=>{});
  const currentHook=await telegram(s,'getWebhookInfo',{}).catch(()=>({}));
  if(currentHook.url===workerUrl+'/telegram')await telegram(s,'deleteWebhook',{drop_pending_updates:false}).catch(()=>{});
  const child=spawn(process.execPath,[path.join(root,'src/cli/watch.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:'ignore'});child.unref();
  await writeFile('data/worker-cutover-failed.json',JSON.stringify({failed_at:new Date().toISOString(),backup,local_restart_pid:child.pid,
    detail:'Worker paused and owned webhook removed. Local watcher restarted against unchanged local data; inspect failed import/activation.'},null,2));
  throw new Error('Cutover did not finish; local watcher restarted. '+error.message);
}
