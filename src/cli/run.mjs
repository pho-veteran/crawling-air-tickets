import {loadEnv} from '../telegram/client.mjs';
import {readFile,mkdir,open,unlink,appendFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {projectRoot} from '../shared/paths.mjs';
import {crawl,queryFrom,queryId,SOURCE} from '../providers/vna.mjs';
import * as vietjet from '../providers/vietjet.mjs';
import {readHistory,writeReport} from '../reporting/report.mjs';
import {settingsFrom} from '../monitoring/alerts.mjs';
import {notifyRecord} from '../monitoring/notify.mjs';
import {createBatch} from '../shared/batch.mjs';

const root=projectRoot;
loadEnv(root);
const {values:args}=parseArgs({options:{'render-only':{type:'boolean',default:false},airline:{type:'string',default:'all'},quick:{type:'boolean',default:false},'no-notify':{type:'boolean',default:false}}});
if(!['all','vna','vietjet'].includes(args.airline))throw new Error('--airline: all, vna hoặc vietjet.');
const providers=[
  {id:'vna',name:'Vietnam Airlines',source:SOURCE,crawl,basis:'Tổng khứ hồi từ bảng so sánh VNA. Giá đi/về lấy riêng từ lịch một chiều, gồm thuế theo nguồn, cho 1 người lớn; tổng hai vé riêng có thể khác giá khứ hồi. Giá tham khảo, chưa xác nhận đặt chỗ.'},
  {id:'vietjet',name:'Vietjet',source:vietjet.SOURCE,crawl:vietjet.crawl,basis:vietjet.BASIS}
];
const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
const query=queryFrom(config),settings=settingsFrom(config.monitoring);
// Let an in-flight snapshot finish and release its lock when watch receives Ctrl+C.
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{});
const dataDir=path.join(root,'data'),historyFile=path.join(dataDir,'history.jsonl'),reportFile=path.join(root,'report','index.html');
await mkdir(dataDir,{recursive:true});
let lock;
const lockFile=path.join(dataDir,'run.lock');
try {lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));}
catch(e) {if(e.code==='EEXIST'){console.error('Đang có lần chạy khác hoặc run.lock chưa được dọn. Kiểm tra PID trước khi xóa lock.');process.exit(3);}throw e;}
try {
  // Every retrieval fires all providers concurrently for the fastest result.
  // Persistence below stays sequential so history lines never interleave.
  const batch=args['render-only']?null:await createBatch({});
  const summaries=[],notifications=[];
  const crawlOne=async provider=>{
    const history=await readHistory(historyFile,query,provider.source);provider.history=history;
    let record,requests=0;
    if(!args['render-only']&&(args.airline==='all'||args.airline===provider.id)) {
      let sent=0;
      const counting=async(...call)=>{const response=await batch.fetch(...call);sent++;return response;};
      try {record=await provider.crawl(query,{fetchImpl:counting});}
      catch(e) {
        record={schema:1,source:provider.source,query_id:queryId(query,provider.source),query,observed_at:new Date().toISOString(),
          status:'error',main_price:null,minimum_price:null,cells:[],requests,error:String(e.message).slice(0,350)};
      }
      requests=sent;record.requests=requests;
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
      main_price_vnd:last?.main_price??null,lowest_nearby_vnd:last?.minimum_price??null,
      priced_cells:last?.cells?.filter(c=>c.price!==null).length??0,error:last?.error??null,
      requests,notification});
    if(record&&!args['no-notify'])notifications.push({provider,record,history,summary:summaries.at(-1)});
  }
  const batchSummary=batch?await batch.finish():null;
  await writeReport({file:reportFile,providers,query,template:path.join(root,'templates','report.html'),batch:batchSummary});
  // Finish both sources before fan-out, so Telegram recipients cannot consume the HTTP batch budget.
  for(const {provider,record,history,summary} of notifications){
    try{summary.notification=await notifyRecord({root,provider,record,history,settings});}
    catch{summary.notification={status:'notification_error',detail:'Kiểm tra .env và data/notification-state.json; dữ liệu giá đã được lưu.'};}
    if(['send_failed','notification_error','retry_wait','busy'].includes(summary.notification.status)&&!process.exitCode)process.exitCode=4;
  }
  console.log(JSON.stringify({airlines:summaries,batch:batchSummary,requests:summaries.reduce((s,p)=>s+p.requests,0),history:historyFile,html:reportFile},null,2));
} finally {await lock.close();await unlink(lockFile);}
