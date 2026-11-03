import {loadEnv} from '../telegram/client.mjs';
import {readFile,mkdir,open,unlink,appendFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {projectRoot} from '../shared/paths.mjs';
import {crawl,queryFrom,queryId,SOURCE,BASIS} from '../providers/vna.mjs';
import * as vietjet from '../providers/vietjet.mjs';
import {readHistory} from '../reporting/history.mjs';
import {settingsFrom} from '../monitoring/alerts.mjs';
import {notifyRecord} from '../monitoring/notify.mjs';
import {createBatch} from '../shared/batch.mjs';
import {createCrawlLog,errorInfo} from '../shared/crawl-log.mjs';

const root=projectRoot;
loadEnv(root);
const {values:args}=parseArgs({options:{airline:{type:'string',default:'all'},quick:{type:'boolean',default:false},'no-notify':{type:'boolean',default:false}}});
if(!['all','vna','vietjet'].includes(args.airline))throw new Error('--airline: all, vna hoặc vietjet.');
const providers=[
  {id:'vna',name:'Vietnam Airlines',source:SOURCE,crawl,basis:BASIS},
  {id:'vietjet',name:'Vietjet',source:vietjet.SOURCE,crawl:vietjet.crawl,basis:vietjet.BASIS}
];
const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
const query=queryFrom(config),settings=settingsFrom(config.monitoring);
// Let an in-flight snapshot finish and release its lock when watch receives Ctrl+C.
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{});
const dataDir=path.join(root,'data'),historyFile=path.join(dataDir,'history.jsonl');
await mkdir(dataDir,{recursive:true});
let lock;
const lockFile=path.join(dataDir,'run.lock');
try {lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));}
catch(e) {if(e.code==='EEXIST'){console.error('Đang có lần chạy khác hoặc run.lock chưa được dọn. Kiểm tra PID trước khi xóa lock.');process.exit(3);}throw e;}
try {
  const log=createCrawlLog(root),runStarted=Date.now();
  log.emit({event:'crawl_start',mode:args.quick?'price':'scheduled_or_manual',airline:args.airline});
  // Every retrieval fires all providers concurrently for the fastest result.
  // Persistence below stays sequential so history lines never interleave.
  const batch=await createBatch({});
  const summaries=[],notifications=[];
  const crawlOne=async provider=>{
    const history=await readHistory(historyFile,query,provider.source);provider.history=history;
    let record,requests=0;
    if(args.airline==='all'||args.airline===provider.id) {
      const started=Date.now(),trace=log.traceFetch(provider.id,batch.fetch);
      log.emit({event:'provider_start',source:provider.id});
      try {record=await provider.crawl(query,{fetchImpl:trace.fetch});}
      catch(e) {
        record={schema:1,source:provider.source,query_id:queryId(query,provider.source),query,observed_at:new Date().toISOString(),
          status:'error',main_price:null,minimum_price:null,cells:[],requests,error:String(e.message).slice(0,350),errors:errorInfo(e)};
      }
      requests=trace.count;record.requests=requests;record.duration_ms=Date.now()-started;
      record.run_id=log.runId;record.request_diagnostics=trace.summaries;
      log.emit({event:'provider_complete',source:provider.id,status:record.status,requests,duration_ms:record.duration_ms,
        errors:record.errors,leg_errors:record.leg_errors,date_errors:record.date_errors});
    }
    return {provider,history,record,requests};
  };
  const crawled=await Promise.all(providers.map(crawlOne));
  for(const {provider,record,history,requests} of crawled) {
    let notification={status:'not_run'};
    if(record) {
      await appendFile(historyFile,JSON.stringify(record)+'\n','utf8');history.push(record);
      if(record.status==='error')process.exitCode=1;
      else if((record.status==='partial'||record.main_price===null)&&process.exitCode!==1)process.exitCode=2;
      notification=args['no-notify']?{status:'suppressed'}:{status:'pending'};
    }
    const last=record??history.at(-1);
    summaries.push({airline:provider.id,status:last?.status??'no_history',observed_at:last?.observed_at??null,
      main_price_vnd:last?.main_price??null,lowest_selected_dates_vnd:last?.minimum_price??null,
      priced_cells:last?.cells?.filter(c=>c.price!==null).length??0,error:last?.error??null,
      requests,notification});
    if(record&&!args['no-notify'])notifications.push({provider,record,history,summary:summaries.at(-1)});
  }
  const batchSummary=batch?await batch.finish():null;
  // Finish both sources before fan-out, so Telegram recipients cannot consume the HTTP batch budget.
  for(const {provider,record,history,summary} of notifications){
    try{summary.notification=await notifyRecord({root,provider,record,history,settings});}
    catch{summary.notification={status:'notification_error',detail:'Kiểm tra .env và data/notification-state.json; dữ liệu giá đã được lưu.'};}
    if(['send_failed','notification_error','retry_wait','busy'].includes(summary.notification.status)&&!process.exitCode)process.exitCode=4;
  }
  log.emit({event:'crawl_complete',duration_ms:Date.now()-runStarted,exit_code:process.exitCode||0,requests:batchSummary.requests});
  console.log(JSON.stringify({run_id:log.runId,airlines:summaries,batch:batchSummary,requests:summaries.reduce((s,p)=>s+p.requests,0),history:historyFile},null,2));
} finally {await lock.close();await unlink(lockFile);}
