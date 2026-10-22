import {createHash} from 'node:crypto';
import config from '../../config.json' with {type:'json'};
import {queryFrom,queryId} from '../providers/vna-core.mjs';
import * as vna from './vna-agencies.mjs';
import * as vietjet from '../providers/vietjet-flynow.mjs';
import {settingsFrom,evaluateAlerts,stillRelevant,formatAlert,alertGroups} from '../monitoring/alerts.mjs';
import {localDay,routeLine} from '../monitoring/messages.mjs';
import {formatCurrentPrices,formatProviderStatus} from '../monitoring/current-prices.mjs';
import {formatFlights} from '../monitoring/flights.mjs';
import {helpText,flightsReminder} from '../telegram/menu.mjs';
import {messageParts} from '../telegram/text.mjs';
import {sendMessage} from './telegram.mjs';
import {digest} from '../storage/d1.mjs';
import {fastLoading,attachRefresh,completeRefresh} from './interactive.mjs';
import {trackedRecord} from '../shared/tracking.mjs';

export const query=queryFrom(config);
export const settings={...settingsFrom(config.monitoring,{}),historyMode:'current-and-minimum'};
export const providers=[{id:'vna',name:'Vietnam Airlines',source:vna.SOURCE,crawl:vna.crawl},
  {id:'vietjet',name:'Vietjet',source:vietjet.SOURCE,crawl:vietjet.crawl}];
const hash=(text,n=24)=>createHash('sha256').update(text).digest('hex').slice(0,n);
const botId=env=>env.TELEGRAM_BOT_TOKEN.split(':')[0];
const dailyKey=(env,chat)=>'daily:'+hash(botId(env)+'|'+chat+'|'+JSON.stringify(query));
const alertKey=(env,chat,p)=>'alerts:'+hash(botId(env)+'|'+chat,16)+':'+p.source+':'+queryId(query,p.source);
const portableFetch=fetchImpl=>(url,options)=>fetchImpl(url,{...options,redirect:options.redirect==='error'?'manual':options.redirect});
const compact=record=>({...record,request_diagnostics:undefined,cells:undefined,
  agency_quotes:record.agency_quotes?.map(q=>({...q,flights:undefined})),
  legs:Object.fromEntries(Object.entries(record.legs||{}).map(([leg,dates])=>[leg,dates.map(q=>({...q,flights:undefined}))]))});

function baseline(p){
  const qid=queryId(query,p.source),current=p.history.at(-1),history=[];
  for(const [kind,date,back] of [['roundtrip',query.departureDate,query.returnDate],['outbound',query.departureDate,''],['inbound',query.returnDate,'']]){
    const min=p.minimumRecords.find(m=>m.kind===kind&&m.departure_date===date&&m.return_date===back);
    if(min)history.push({schema:1,status:'ok',source:p.source,query_id:qid,query,observed_at:new Date(min.observed_ms).toISOString(),
      main_price:kind==='roundtrip'?min.price:null,legs:kind==='roundtrip'?{}:{[kind]:[{date,price:min.price}]},comparison_only:true});
  }
  // Put the actual previous current last; minimum candidates are never a previous crawl.
  if(current)history.push(compact(current));
  return history;
}
export async function context(store){
  const pairs=providers.flatMap(p=>[p.source,queryId(query,p.source)]);
  const [records,minima]=await Promise.all([
    store.statement('SELECT source,record_json FROM observations WHERE (source=? AND query_id=?) OR (source=? AND query_id=?)',...pairs).all(),
    store.statement('SELECT * FROM price_minima WHERE (basis_source=? AND query_id=?) OR (basis_source=? AND query_id=?)',...pairs).all(),
  ]);
  const result=[];
  for(const p of providers){
    const raw=records.results.find(r=>r.source===p.source),record=raw?trackedRecord(JSON.parse(raw.record_json),query):null,minimums={};
    const minimumRecords=minima.results.filter(m=>m.basis_source===p.source);
    for(const [kind,key,date,back] of [['roundtrip','main',query.departureDate,query.returnDate],['outbound','outbound',query.departureDate,''],['inbound','inbound',query.returnDate,'']])
      minimums[key]=minimumRecords.find(m=>m.kind===kind&&m.departure_date===date&&m.return_date===back)?.price??null;
    result.push({...p,history:record?[record]:[],minimums,minimumRecords});
  }
  return {providers:result,query,settings};
}
export async function enqueueText(store,id,chatId,text,options={}){
  const ids=[];
  for(const [i,part] of messageParts(text).entries())ids.push(await store.queueText(id+':'+i,chatId,part,options));
  return ids;
}
async function crawlJob(store,env,job,fetchImpl){
  const began=store.now(),histories=job.body.baselines||[];
  const current=await context(store);
  if(!job.body.baselines){
    for(const p of current.providers)histories.push(baseline(p));
    job.body.baselines=histories;
    await store.mutate('UPDATE jobs SET body_json=? WHERE id=?',JSON.stringify(job.body),job.id);
  }
  const existing=[];
  for(const p of current.providers){const record=p.history.at(-1);existing.push(record?.job_id===job.id?{record_json:JSON.stringify(record)}:null);}
  const results=await Promise.all(providers.map(async(p,i)=>{
    if(existing[i]){const r=JSON.parse(existing[i].record_json);return r.last_attempt_failed?{...r,status:'error',main_price:null,legs:{},cells:[],observed_at:r.last_attempt_at,error:r.last_attempt_error}:r;}
    try{return await p.crawl(query,{fetchImpl:portableFetch(fetchImpl),store,env});}
    catch(error){return {schema:1,source:p.source,query_id:queryId(query,p.source),query,observed_at:new Date(store.now()).toISOString(),
      status:'error',main_price:null,minimum_price:null,cells:[],error:String(error.message).slice(0,250),source_error_code:error.sourceCode||null,
      requests:error.requests??1,agency_quotes:error.agency_quotes};}
  }));
  for(const [i,p] of providers.entries()){
    const record={...results[i],job_id:job.id,history_mode:'current-and-minimum'};
    if(!existing[i])await store.observeCurrent(record);
    if(!job.body.silent&&job.kind!=='refresh')await store.createJob(job.id+':notify:'+p.id,'notify',{providerId:p.id,record:compact(record),history:histories[i]});
  }
  if(job.body.command)await store.createJob(job.id+':reply','reply',{chatId:job.body.chatId,command:job.body.command});
  if(job.body.day&&job.kind!=='refresh')await store.createJob('daily:'+job.body.day,'daily',{day:job.body.day});
  if(job.kind==='refresh'){
    const latestJob=await store.statement('SELECT body_json FROM jobs WHERE id=?',job.id).first();
    const day=JSON.parse(latestJob.body_json).day;
    await store.createJob(job.id+':broadcast','broadcast',{day,items:providers.map((p,i)=>({providerId:p.id,record:compact(results[i]),history:histories[i]}))});
    await completeRefresh(store,job.id,results.every(r=>r.status==='ok'));
  }
  console.log(JSON.stringify({event:'crawl_complete',job_id:job.id,wall_ms:store.now()-began,
    results:results.map(r=>({source:r.source,status:r.status,requests:r.requests??1,...(r.source_error_code?{source_error_code:r.source_error_code}:{})}))}));
}
async function fanout(store,env,job,kind){
  const shared=await store.state('shared-chat',{});
  const recipients=shared.chatId?(job.body.after?[]:[shared.chatId]):await store.subscribers(botId(env),job.body.after||'');
  for(const chatId of recipients)await store.createJob(job.id+':'+hash(chatId),kind,{...job.body,parentId:job.body.parentId||job.id,chatId});
  if(recipients.length===15)await store.createJob(job.id+':next:'+hash(recipients.at(-1)),job.kind,{...job.body,parentId:job.body.parentId||job.id,after:recipients.at(-1)});
}
async function alertRecipient(store,env,job){
  const data=job.body.record?job.body:JSON.parse((await store.statement('SELECT body_json FROM jobs WHERE id=?',job.body.parentId).first()).body_json);
  const {providerId,history}=data,record=trackedRecord(data.record,query),p=providers.find(p=>p.id===providerId);
  const key=alertKey(env,job.body.chatId,p),state=await store.state(key,{initialized:false,incidentOpen:false,sent:{}});
  state.sent=Object.fromEntries(Object.entries(state.sent||{}).filter(([,at])=>store.now()-at<settings.repeatCooldownHours*3600000));
  if(settings.priceOnly)state.initialized=true;
  const goodBefore=history.some(r=>r.observed_at<record.observed_at&&['ok','partial'].includes(r.status)&&!r.comparison_only);
  const allowed=e=>!settings.priceOnly||goodBefore&&e.key!=='baseline'&&['main','leg'].includes(e.guard.kind);
  const events=evaluateAlerts(p,record,history,state,settings).filter(allowed);
  const eligible=e=>state.sent?.[e.key]===undefined||store.now()-state.sent[e.key]>=settings.repeatCooldownHours*3600000;
  const pending=new Map((state.pending||[]).filter(e=>allowed(e)&&stillRelevant(e,record)&&eligible(e)).map(e=>[e.key,e]));
  for(const e of events)if(eligible(e))pending.set(e.key,e);
  state.pending=[...pending.values()];if(record.status!=='error')state.incidentOpen=false;
  await store.putState(key,state);
  for(const group of alertGroups(state.pending)){
    const id='alert:'+hash(key+'|'+group.map(e=>e.key).join('|')+'|'+Math.floor(store.now()/(settings.repeatCooldownHours*3600000)));
    const guards=group.map(e=>({...e,providerId:p.id}));
    await enqueueText(store,id,job.body.chatId,formatAlert(p,record,group,history),{kind:'alert',guards,stateKey:key,notBefore:state.nextAttemptAt||0});
  }
}
async function dailyRecipient(store,env,job){
  const parent=job.body.day?job.body:JSON.parse((await store.statement('SELECT body_json FROM jobs WHERE id=?',job.body.parentId).first()).body_json);
  const key=dailyKey(env,job.body.chatId),state=await store.state(key,{});
  if(state.day===parent.day&&(state.sent||state.messageId))return;
  const c=await context(store),text=state.day===parent.day&&state.messageVersion===2&&state.message||formatCurrentPrices({...c,now:store.now(),pollMinutes:settings.pollMinutes});
  await enqueueText(store,'daily:'+hash(key)+'|'+parent.day,job.body.chatId,text,{kind:'daily',stateKey:key,notBefore:state.day===parent.day?state.nextAttemptAt||0:0});
}
async function reply(store,job,env,fetchImpl){
  const c=await context(store),text=job.body.command==='flights'?formatFlights({...c,now:store.now(),pollMinutes:settings.pollMinutes}):
    formatCurrentPrices({...c,now:store.now(),pollMinutes:settings.pollMinutes,onDemand:true})+'\n\n'+flightsReminder;
  const ids=await enqueueText(store,job.id,job.body.chatId,text,{requestId:job.body.requestId});
  if(job.body.requestId)for(const id of ids){
    const cooldown=await store.state('telegram-cooldown',{until:0});
    if(cooldown.until>store.now())break;
    const row=await store.statement('SELECT * FROM jobs WHERE id=?',id).first();
    if(row.status!=='pending')continue;
    // Same delivery-lane lease, durable outbox and ACK; Queue is only fallback.
    try{
      await sendJob(store,env,{...row,body:JSON.parse(row.body_json)},fetchImpl);
      await store.mutate("UPDATE jobs SET status='done',done_ms=?,body_json='{}' WHERE id=?",store.now(),id);
    }catch{console.log(JSON.stringify({event:'inline_send_deferred',job_id:id}));}
  }
}
async function command(store,env,job,fetchImpl){
  const {command,chatId}=job.body;
  if(['price','flights'].includes(command)){
    if(job.body.optimized){
      if(!await fastLoading(store,env,job.id,fetchImpl))throw Object.assign(new Error('Loading awaiting delivery'),{delaySeconds:5});
      const refresh=await attachRefresh(store,job.id);
      if(refresh.status==='done'){
        const ready=await store.statement('SELECT * FROM jobs WHERE id=?',job.id+':reply').first();
        if(ready?.status==='pending'){
          await reply(store,{...ready,body:JSON.parse(ready.body_json)},env,fetchImpl);
          await store.mutate("UPDATE jobs SET status='done',done_ms=?,body_json='{}' WHERE id=?",store.now(),ready.id);
        }
      }
      return;
    }
    const text=command==='flights'?'⏳ Đang kiểm tra giờ bay và giá hai hãng, xong mình gửi ngay nhé...':
      '⏳ Đang kiểm tra giá mới hai hãng, xong mình gửi ngay nhé...';
    await store.queueText(job.id+':loading',chatId,text,{afterSend:{id:job.id+':crawl',kind:'crawl',body:{silent:true,command,chatId}}});return;
  }
  let text=command==='stop'?'🔕 Đã ngừng nhận tin tự động. Bạn vẫn dùng được /price và /flights; /start để nhận lại.':
    ['start','help','hello'].includes(command)?(command==='start'?'🔔 Đã đăng ký nhận cảnh báo và bản tin.\n\n':'')+helpText+'\n\n/stop — Ngừng nhận tin tự động.':
    '🤔 Mình chưa có lệnh này. Gõ /help để xem hướng dẫn.';
  if(job.body.shared&&['start','stop','help','hello'].includes(command))text=helpText+'\n\n👥 Thông báo tự động được gửi vào nhóm chung. Mọi thành viên dùng được /price và /flights. Bạn có thể tắt thông báo hoặc rời nhóm trong Telegram; /stop không tắt bản tin của cả nhóm.';
  if(['status','connection'].includes(command)){
    const c=await context(store),count=await store.statement('SELECT COUNT(*) AS n FROM subscribers WHERE bot_id=? AND active=1',botId(env)).first();
    text='🟢 Bot đang hoạt động trên Cloudflare Workers.\n'+routeLine(query)+'\n🔄 Lịch kiểm tra mỗi 10 phút; nguồn giá có thể cập nhật trễ.\n☀️ Bản tin 07:00 giờ Việt Nam.\n'+(job.body.shared?'👥 Thông báo tại nhóm chung.':'👥 Người đăng ký: '+count.n+'.')+'\n'+c.providers.map(p=>formatProviderStatus(p,{now:store.now(),pollMinutes:settings.pollMinutes})).join('\n')+'\n\n/price — Kiểm tra giá mới. /flights — Xem giờ bay.';
  }
  await enqueueText(store,job.id,chatId,text,{requestId:job.body.optimized?job.id:null});
}
export async function sendJob(store,env,job,fetchImpl){
  if(!env.DELIVERY)return sendJobLocked(store,env,job,fetchImpl);
  const lease=await store.acquireLease('telegram-delivery',crypto.randomUUID(),{now:store.now(),ttlMs:30000});
  if(!lease)throw Object.assign(new Error('Telegram sender busy'),{delaySeconds:2,noAttempt:true});
  try{return await sendJobLocked(store,env,job,fetchImpl);}finally{await store.releaseLease(lease);}
}
async function sendJobLocked(store,env,job,fetchImpl){
  const o=await store.statement('SELECT * FROM outbox WHERE id=?',job.body.outboxId).first();
  const continueAfterSend=async()=>{
    const next=job.body.afterSend;if(next)await store.createJob(next.id,next.kind,next.body);
    if(job.body.requestId){
      const pending=await store.statement("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE ? AND status='pending'",job.body.requestId+':reply:%').first();
      if(!pending.n)await store.mutate('UPDATE interactive SET completed_ms=COALESCE(completed_ms,?) WHERE id=?',store.now(),job.body.requestId);
    }
  };
  if(!o)return;
  // Recover a crash between the durable Telegram ACK and enqueueing the crawl.
  if(o.status==='sent'){await continueAfterSend();return;}
  if(o.status!=='pending')return;
  const cooldown=await store.state('telegram-cooldown',{until:0}),at=Math.max(o.not_before,cooldown.until||0);
  if(at>store.now())throw Object.assign(new Error('Delivery delayed'),{delaySeconds:Math.ceil((at-store.now())/1000),noAttempt:true});
  if(o.kind!=='manual'){
    const shared=await store.state('shared-chat',{});
    if(shared.chatId&&o.chat_id!==shared.chatId){await store.mutate("UPDATE outbox SET status='discarded' WHERE id=?",o.id);return;}
    const sub=await store.statement('SELECT active FROM subscribers WHERE bot_id=? AND chat_id=?',botId(env),o.chat_id).first();
    if(!sub?.active){await store.mutate("UPDATE outbox SET status='discarded' WHERE id=?",o.id);return;}
  }
  const guards=JSON.parse(o.guards_json);
  if(o.kind==='alert'){
    const p=providers.find(p=>p.id===guards[0]?.providerId),raw=await store.latest(p.source,queryId(query,p.source)),latest=raw?trackedRecord(raw,query):null;
    if(!latest||latest.last_attempt_failed||guards.some(e=>!stillRelevant(e,latest))){await store.mutate("UPDATE outbox SET status='discarded' WHERE id=?",o.id);return;}
  }
  await store.assertOwner();
  await store.mutate('UPDATE outbox SET attempts=attempts+1 WHERE id=?',o.id);
  try{
    const result=await sendMessage(env,o.chat_id,o.message,fetchImpl);
    if(!Number.isSafeInteger(result?.message_id))throw Object.assign(new Error('Delivery ACK missing'),{uncertain:true});
    await store.mutate("UPDATE outbox SET status='sent',message_id=?,message='',guards_json='[]' WHERE id=?",result.message_id,o.id);
    if(job.body.requestId){
      const req=await store.statement('SELECT created_ms,loading_ms FROM interactive WHERE id=?',job.body.requestId).first();
      console.log(JSON.stringify({event:'interactive_complete',request_id:job.body.requestId,latency_ms:store.now()-req.created_ms,loading_ms:req.loading_ms?req.loading_ms-req.created_ms:null}));
    }
    if(o.state_key){
      const state=await store.state(o.state_key,{});
      if(o.kind==='daily'){
        const unfinished=await store.statement("SELECT COUNT(*) AS n FROM outbox WHERE state_key=? AND kind='daily' AND id LIKE ? AND status='pending'",o.state_key,'daily:%|'+localDay(o.created_ms)+':%').first();
        if(unfinished.n===0){Object.assign(state,{day:localDay(o.created_ms),sent:true,messageId:result.message_id,sent_at:new Date(store.now()).toISOString()});delete state.message;delete state.messageVersion;}
      }else{
        state.attempts=0;state.nextAttemptAt=0;
        state.sent||={};for(const e of guards){state.sent[e.key]=store.now();if(e.key==='baseline')state.initialized=true;if(e.key==='error')state.incidentOpen=true;}
        state.pending=(state.pending||[]).filter(e=>!guards.some(g=>g.key===e.key));
      }
      await store.putState(o.state_key,state);
    }
    // Shared pacing survives deploys and applies to both slash and broadcast replies.
    await store.putState('telegram-cooldown',{until:store.now()+1100});
    console.log(JSON.stringify({event:'delivery_complete',job_id:job.id,message_id:result.message_id,kind:o.kind}));
  }catch(error){
    if(error.apiCode===403){
      await store.mutate('UPDATE subscribers SET active=0 WHERE bot_id=? AND chat_id=?',botId(env),o.chat_id);
      await store.mutate("UPDATE outbox SET status='discarded' WHERE id=?",o.id);
      if(job.body.requestId)await store.mutate('UPDATE interactive SET completed_ms=? WHERE id=?',store.now(),job.body.requestId);
      return;
    }
    const wait=error.apiCode===429?error.retryAfter:Math.min(21600,60*2**Math.min(o.attempts,8));
    await store.mutate('UPDATE outbox SET not_before=? WHERE id=?',store.now()+wait*1000,o.id);
    if(error.apiCode===429)await store.putState('telegram-cooldown',{until:store.now()+wait*1000});
    if(error.uncertain)console.log(JSON.stringify({event:'delivery_uncertain',job_id:job.id,attempt:o.attempts+1}));
    throw Object.assign(error,{delaySeconds:wait});
  }
  await continueAfterSend();
}
export async function executeJob(store,env,job,fetchImpl=fetch){
  job={...job,body:JSON.parse(job.body_json)};
  if(['crawl','refresh'].includes(job.kind))return crawlJob(store,env,job,fetchImpl);
  if(job.kind==='command')return command(store,env,job,fetchImpl);
  if(job.kind==='broadcast'){
    const shared=await store.state('shared-chat',{});
    if(shared.chatId){
      for(const item of job.body.items)await alertRecipient(store,env,{...job,body:{...item,chatId:shared.chatId}});
      if(job.body.day)await dailyRecipient(store,env,{...job,body:{day:job.body.day,chatId:shared.chatId}});
    }else{
      for(const item of job.body.items)await store.createJob(job.id+':'+item.providerId,'notify',item);
      if(job.body.day)await store.createJob('daily:'+job.body.day,'daily',{day:job.body.day});
    }
    return;
  }
  if(job.kind==='reply')return reply(store,job,env,fetchImpl);
  if(job.kind==='notify')return fanout(store,env,job,'alert-recipient');
  if(job.kind==='alert-recipient')return alertRecipient(store,env,job);
  if(job.kind==='daily'){
    if(job.body.refreshId){
      const refresh=await store.statement('SELECT status FROM jobs WHERE id=?',job.body.refreshId).first();
      if(!refresh||!['done','failed'].includes(refresh.status))
        throw Object.assign(new Error('Daily awaiting fresh prices'),{delaySeconds:15,noAttempt:true});
      const shared=await store.state('shared-chat',{});
      if(shared.chatId)return dailyRecipient(store,env,{...job,body:{...job.body,chatId:shared.chatId}});
    }
    return fanout(store,env,job,'daily-recipient');
  }
  if(job.kind==='daily-recipient')return dailyRecipient(store,env,job);
  if(job.kind==='send')return sendJob(store,env,job,fetchImpl);
  if(job.kind==='retention'){
    await store.mutate('DELETE FROM interactive WHERE completed_ms<?',store.now()-30*86400000);
    await store.mutate("UPDATE runtime_state SET document_json=json_remove(document_json,'$.message','$.messageVersion') WHERE key LIKE 'daily:%' AND (json_extract(document_json,'$.sent')=1 OR json_extract(document_json,'$.messageId') IS NOT NULL)");
    await store.mutate("DELETE FROM telegram_updates WHERE received_ms<?",store.now()-30*86400000);
    // Job/outbox ACKs remain 30 days; stable update IDs prevent duplicate commands.
    await store.mutate("DELETE FROM jobs WHERE status='done' AND done_ms<? AND id NOT IN (SELECT job_id FROM telegram_updates)",store.now()-30*86400000);
    await store.mutate("DELETE FROM outbox WHERE status IN ('sent','discarded') AND created_ms<?",store.now()-30*86400000);return;
  }
  throw new Error('Unknown job kind');
}
