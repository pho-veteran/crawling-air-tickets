import {setTimeout as delay} from 'node:timers/promises';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {credentials,sendTelegram} from './telegram.mjs';
import {evaluateAlerts,stillRelevant,formatAlert,alertGroups} from './alerts.mjs';

async function save(file,value){await writeFile(file+'.tmp',JSON.stringify(value,null,2));await rename(file+'.tmp',file);}
export async function notifyRecord({root,provider,record,history,settings,creds=credentials(root),send=sendTelegram,now=Date.now()}) {
  const dir=path.join(root,'data'),file=path.join(dir,'notification-state.json');
  await mkdir(dir,{recursive:true});
  let db={schema:1,accounts:{}};
  try{db=JSON.parse(await readFile(file,'utf8'));if(db.schema!==1||!db.accounts)throw new Error();}
  catch(e){if(e.code!=='ENOENT')throw new Error('notification-state.json không hợp lệ; giữ lại file để kiểm tra.');}
  const account=createHash('sha256').update((creds.token?.split(':')[0]||'')+'|'+(creds.chatId||'')).digest('hex').slice(0,16);
  const bucket=db.accounts[account]??={},key=provider.source+':'+record.query_id;
  const state=bucket[key]??={initialized:false,incidentOpen:false,sent:{},pending:[],attempts:0,nextAttemptAt:0};
  // Price-only polling silently initializes; daily reports and slash commands are independent.
  if(settings.priceOnly)state.initialized=true;
  const hasComparison=history.some(r=>r.observed_at<record.observed_at&&['ok','partial'].includes(r.status));
  const allowed=e=>!settings.priceOnly||(hasComparison&&e.key!=='baseline'&&['main','leg'].includes(e.guard.kind));
  const events=evaluateAlerts(provider,record,history,state,settings).filter(allowed),cooldown=settings.repeatCooldownHours*3600000;
  const eligible=e=>state.sent[e.key]===undefined||now-state.sent[e.key]>=cooldown;
  state.sent=Object.fromEntries(Object.entries(state.sent).filter(([,at])=>now-at<cooldown));
  const pending=new Map(state.pending.filter(e=>allowed(e)&&stillRelevant(e,record)&&eligible(e)).map(e=>[e.key,e]));
  for(const e of events)if(eligible(e))pending.set(e.key,e);
  state.pending=[...pending.values()];
  if(record.status!=='error')state.incidentOpen=false;
  const message=formatAlert(provider,record,state.pending,history);
  await writeFile(path.join(dir,'alert-preview-'+provider.id+'.txt'),message,'utf8');
  if(!creds.enabled||!creds.configured)return {status:creds.enabled?'unconfigured':'disabled',events:state.pending.length};
  bucket[key]=state;db.accounts[account]=bucket;
  await save(file,db);
  if(!state.pending.length)return {status:'unchanged',events:0};
  if(now<state.nextAttemptAt)return {status:'retry_wait',events:state.pending.length};
  let messageId;const count=state.pending.length;
  try {for(const group of alertGroups(state.pending)){messageId=await send(creds,formatAlert(provider,record,group,history));for(const e of group){state.sent[e.key]=now;if(e.key==='baseline')state.initialized=true;if(e.key==='error')state.incidentOpen=true;}const keys=new Set(group.map(e=>e.key));state.pending=state.pending.filter(e=>!keys.has(e.key));await save(file,db);if(state.pending.length)await delay(1100);}}
  catch(e) {
    state.attempts++;
    const seconds=Math.max(60,Math.min(21600,60*2**Math.min(state.attempts-1,9)),e.retryAfter||0);
    state.nextAttemptAt=now+seconds*1000;await save(file,db);
    const code=/^TELEGRAM_[A-Z_0-9]+/.exec(String(e.message))?.[0]||'TELEGRAM_SEND_FAILED';
    return {status:'send_failed',code,events:state.pending.length,retryAfterSeconds:seconds};
  }
  for(const e of state.pending){state.sent[e.key]=now;if(e.key==='baseline')state.initialized=true;if(e.key==='error')state.incidentOpen=true;}
  state.pending=[];state.attempts=0;state.nextAttemptAt=0;await save(file,db);
  return {status:'sent',events:count,messageId};
}
