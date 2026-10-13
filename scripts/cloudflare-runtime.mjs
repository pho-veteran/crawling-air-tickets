import {parseArgs} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {worker,secrets,RemoteD1,workerUrl} from './lib/worker-api.mjs';
import {D1Repository,digest} from '../src/storage/d1.mjs';
import {RuntimeStore} from '../src/worker/runtime-store.mjs';
import {importFiles,planImport,applyImport} from '../src/storage/import.mjs';
import {commandMenu} from '../src/telegram/menu.mjs';
import {query,providers} from '../src/worker/jobs.mjs';
import {queryId} from '../src/providers/vna-core.mjs';
import {telegram} from '../src/worker/telegram.mjs';
const {values:args}=parseArgs({options:{preflight:{type:'boolean'},import:{type:'string'},activate:{type:'boolean'},pause:{type:'boolean'},inspect:{type:'boolean'}}});
const database=JSON.parse(await readFile('data/worker-database.json','utf8')),remote=new RemoteD1(database.id),repo=new RuntimeStore(remote);
if(args.preflight){
  if((await worker('/health')).active)throw new Error('Preflight is only for an inactive empty destination; use /price on an active bot.');
  const initial=await repo.statement('SELECT (SELECT COUNT(*) FROM observations)+(SELECT COUNT(*) FROM price_minima) AS n').first();
  if(initial.n)throw new Error('Preflight requires an empty pricing destination; existing prices were preserved.');
  const queued=await worker('/admin/enqueue',{method:'POST',body:{kind:'crawl',silent:true,preflight:true}});
  const until=Date.now()+120000;let status;
  while(Date.now()<until){status=await repo.statement('SELECT id,kind,status,attempts,not_before FROM jobs WHERE id=?',queued.job_id).first();if(status?.status==='done'||status?.status==='failed')break;await new Promise(r=>setTimeout(r,1500));}
  if(status?.status!=='done')throw new Error('Preflight crawl did not complete; local bot remains active.');
  const c=await worker('/admin/context'),summaries=c.providers.map(p=>({source:p.source,status:p.history.at(-1)?.status,price:p.history.at(-1)?.main_price}));
  const report={observed_at:new Date().toISOString(),worker:workerUrl,job_id:queued.job_id,sources:summaries,health:await worker('/health')};
  await writeFile('data/worker-runtime-preflight.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  if(summaries.some(p=>p.status!=='ok'))throw new Error('Provider preflight failed.');
  // Only the exact disposable preflight records; done before private import.
  const ids=providers.map(p=>'current:'+p.source+':'+queryId(query,p.source));
  const placeholders=ids.map(()=>'?').join(',');
  await remote.batch([
    repo.statement(`DELETE FROM price_minima WHERE observed_ms IN (SELECT observed_ms FROM observations WHERE id IN (${placeholders})) AND basis_source IN (?,?)`,...ids,...providers.map(p=>p.source)),
    repo.statement(`DELETE FROM observations WHERE id IN (${placeholders})`,...ids),
  ]);
}
if(args.import){
  const folder=path.resolve(args.import),inputs={};
  if(!folder.startsWith(path.resolve('data')+path.sep))throw new Error('Use a captured backup inside project data.');
  if((await worker('/health')).active)throw new Error('Pause Worker before import.');
  const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));if(!manifest.verified)throw new Error('Backup not verified.');
  for(const name of importFiles)try{const bytes=await readFile(path.join(folder,name));if(digest(bytes)!==manifest.files[name]?.sha256)throw new Error('Backup checksum mismatch');inputs[name]={text:bytes.toString(),hash:digest(bytes)};}catch(error){if(error.code!=='ENOENT')throw error;}
  const plan=planImport(inputs);const first=await applyImport(repo,plan),again=await applyImport(repo,plan);
  if(again.insertedObservations!==0)throw new Error('Repeated import changed history.');
  const s=await secrets(),bot=s.TELEGRAM_BOT_TOKEN.split(':')[0],hash=(t,n=24)=>createHash('sha256').update(t).digest('hex').slice(0,n);
  let mappedAlerts=0,mappedDaily=0;
  for(const doc of plan.documents){
    if(doc.namespace==='notification-state.json')for(const [account,bucket] of Object.entries(doc.document.accounts))for(const [key,value] of Object.entries(bucket)){
      await repo.putState('alerts:'+account+':'+key,value);mappedAlerts++;
    }
    if(doc.namespace==='daily-state.json')for(const [key,value] of Object.entries(doc.document.entries)){await repo.putState('daily:'+key,value);mappedDaily++;}
    if(doc.namespace==='bot-state.json'){
      const state=doc.document.entries[hash(bot+'|listener')]||doc.document.entries[hash(bot+'|'+(process.env.TELEGRAM_CHAT_ID||''))];
      if(state)await repo.putState('telegram-min-update',{offset:state.offset||0});
    }
    if(doc.namespace==='telegram-subscribers.json')await repo.putState('telegram-cooldown',{until:doc.document.bots[bot]?.nextBroadcastAt||0});
  }
  const result={observed_at:new Date().toISOString(),database_id:database.id,verified:first.verified,summary:first.summary,
    repeated_inserted:again.insertedObservations,mapped_alert_states:mappedAlerts,mapped_daily_states:mappedDaily,
    snapshot:folder,d1:remote.totals,local_data_unchanged:true};
  await writeFile('data/worker-import-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
if(args.activate){
  const s=await secrets();const hook=await telegram(s,'getWebhookInfo',{});
  if(hook.url&&hook.url!==workerUrl+'/telegram')throw new Error('Unexpected existing webhook; inspect before replacing it.');
  await telegram(s,'setMyCommands',{commands:commandMenu,scope:{type:'all_private_chats'}});
  await worker('/admin/activate',{method:'POST',body:{active:true}});
  try{await telegram(s,'setWebhook',{url:workerUrl+'/telegram',secret_token:s.WEBHOOK_SECRET,allowed_updates:['message'],drop_pending_updates:false,max_connections:1});}
  catch(error){await worker('/admin/activate',{method:'POST',body:{active:false}});throw error;}
  const verified=await telegram(s,'getWebhookInfo',{});if(verified.url!==workerUrl+'/telegram')throw new Error('Webhook not installed.');
  const result={observed_at:new Date().toISOString(),worker:workerUrl,webhook_url:verified.url,pending_updates:verified.pending_update_count,
    health:await worker('/health'),state:await worker('/admin/state')};
  await writeFile('data/worker-activation.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
if(args.pause){await worker('/admin/activate',{method:'POST',body:{active:false}});console.log('Worker paused; webhook retained so pending updates are not discarded.');}
if(args.inspect)console.log(JSON.stringify({health:await worker('/health'),state:await worker('/admin/state')},null,2));
