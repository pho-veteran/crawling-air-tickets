import {timingSafeEqual} from 'node:crypto';
import {RuntimeStore} from './runtime-store.mjs';
import config from '../../config.json' with {type:'json'};
import {localDay} from '../monitoring/messages.mjs';
import {meter} from './d1-meter.mjs';
import {admit,requestRefresh,completeRefresh,fastLoading} from './interactive.mjs';
import {feedKey} from './vna-agencies.mjs';
import {validateFeed} from './vna-feed.mjs';
import {queryFrom} from '../providers/vna-core.mjs';
import {canonicalJson} from '../storage/d1.mjs';

const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const equal=(a,b)=>{const x=new TextEncoder().encode(a||''),y=new TextEncoder().encode(b||'');return x.length===y.length&&(crypto.subtle.timingSafeEqual?crypto.subtle.timingSafeEqual(x,y):timingSafeEqual(x,y));};
const admin=(r,env)=>!!env.ADMIN_SECRET&&equal(r.headers.get('authorization'),'Bearer '+env.ADMIN_SECRET);
async function body(request){
  const reader=request.body?.getReader();if(!reader)return {};
  const chunks=[];let bytes=0;
  try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>65536)throw new Error('body size');chunks.push(r.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const data=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(data));
}
export async function dispatch(store,env){
  const stamp=store.now();
  // Claim before sending: both lanes and webhook may dispatch concurrently.
  const rows=(await store.statement("UPDATE jobs SET queued_ms=? WHERE id IN (SELECT id FROM jobs WHERE status IN ('pending','running') AND not_before<=? AND queued_ms<? ORDER BY created_ms,id LIMIT 15) RETURNING id,kind",stamp,stamp,stamp-60000).all()).results;
  const priority={command:0,reply:1,send:2};rows.sort((a,b)=>(priority[a.kind]??3)-(priority[b.kind]??3));
  if(!rows.length)return 0;
  try{
    const crawl=rows.filter(r=>['crawl','refresh','retention'].includes(r.kind)),delivery=rows.filter(r=>!['crawl','refresh','retention'].includes(r.kind));
    if(crawl.length)await env.JOBS.sendBatch(crawl.map(r=>({body:{jobId:r.id}})));
    if(delivery.length)await (env.DELIVERY||env.JOBS).sendBatch(delivery.map(r=>({body:{jobId:r.id}})));
  }catch(error){
    await store.statement('UPDATE jobs SET queued_ms=0 WHERE queued_ms=? AND id IN ('+rows.map(()=>'?').join(',')+')',stamp,...rows.map(r=>r.id)).run();throw error;
  }
  return rows.length;
}
export async function webhook(request,env,store,{fast=false,fetchImpl=fetch}={}){
  if(!env.WEBHOOK_SECRET||!equal(request.headers.get('x-telegram-bot-api-secret-token'),env.WEBHOOK_SECRET))return json({error:'Unauthorized'},401);
  const state=Object.fromEntries((await store.statement("SELECT key,document_json FROM runtime_state WHERE key IN ('control','telegram-min-update','shared-chat','quota-policy')").all()).results.map(r=>[r.key,JSON.parse(r.document_json)]));
  if(!state.control?.active)return json({error:'Temporarily inactive'},503);
  let u;try{u=await body(request);}catch{return json({error:'Invalid update'},400);}
  if(!Number.isSafeInteger(u.update_id)||u.update_id<0)return json({error:'Invalid update ID'},400);
  if(u.update_id<(state['telegram-min-update']?.offset||0))return json({ok:true});
  const m=u.message,shared=state['shared-chat']||{};
  if(String(m?.chat?.id)===shared.chatId&&m.chat.type==='group'&&Number.isSafeInteger(m.migrate_to_chat_id)&&m.migrate_to_chat_id<0){
    await store.migrateSharedChat(shared,String(m.migrate_to_chat_id),env.TELEGRAM_BOT_TOKEN.split(':')[0]);
    return json({ok:true});
  }
  const group=['group','supergroup'].includes(m?.chat?.type);
  if(!m?.chat||!Number.isSafeInteger(m.chat.id)||m.from?.is_bot)return json({ok:true});
  if(group?String(m.chat.id)!==shared.chatId:m.chat.type!=='private'||m.chat.id<=0)return json({ok:true});
  const match=typeof m.text==='string'?m.text.trim().match(/^\/(\w+)(?:@(\w+))?(?:\s|$)/):null;
  if(match?.[2]&&match[2].toLowerCase()!==env.BOT_USERNAME?.toLowerCase())return json({ok:true});
  if(group&&!match)return json({ok:true});
  if(m.date&&store.now()/1000-m.date>300)return json({ok:true});
  const command=match?.[1]?.toLowerCase()||'hello';
  try{
    if(env.OPTIMIZED==='1'){
      if(!['price','flights','status','help','start','stop','connection'].includes(command))return json({ok:true});
      const policy=state['quota-policy'],dailyLimit=policy?.day===new Date(store.now()).toISOString().slice(0,10)?policy.command_limit:200;
      const accepted=await admit(store,env.TELEGRAM_BOT_TOKEN.split(':')[0],u.update_id,{chatId:String(m.chat.id),command,shared:!!shared.chatId,group},{dailyLimit});
      if(fast&&accepted?.status==='pending')await fastLoading(store,env,accepted.id,fetchImpl);
      if(accepted?.status==='pending'){
        const claimed=await store.statement("UPDATE jobs SET queued_ms=? WHERE id=? AND queued_ms=0 RETURNING id",store.now(),accepted.id).first();
        if(claimed)try{await (env.DELIVERY||env.JOBS).send({jobId:claimed.id});}
        catch(error){await store.statement('UPDATE jobs SET queued_ms=0 WHERE id=?',claimed.id).run();throw error;}
      }
      return json({ok:true});
    }
    const id=await store.receiveUpdate(env.TELEGRAM_BOT_TOKEN.split(':')[0],u.update_id,{chatId:String(m.chat.id),command,shared:!!shared.chatId,group}, {subscribe:!shared.chatId});
    await env.JOBS.send({jobId:id});
  }catch{console.log(JSON.stringify({event:'webhook_persistence_failed'}));return json({error:'Persistence unavailable'},503);}
  return json({ok:true});
}
export async function consume(message,env,{fetchImpl=fetch,now=Date.now}={}){
  const {executeJob}=await import('./jobs.mjs');
  const measured=meter(env.DB),store=new RuntimeStore(measured.db,{now}),id=message.body?.jobId;
  if(typeof id!=='string'||id.length>250){message.ack();return;}
  const job=await store.statement('SELECT * FROM jobs WHERE id=?',id).first();
  if(!job||['done','failed'].includes(job.status)){message.ack();return;}
  const control=await store.state('control',{active:false});
  if(!control.active&&!JSON.parse(job.body_json).preflight){message.retry({delaySeconds:60});return;}
  if(job.not_before>now()){message.retry({delaySeconds:Math.min(86400,Math.ceil((job.not_before-now())/1000))});return;}
  const lane=env.DELIVERY?(['crawl','refresh','retention'].includes(job.kind)?'crawl-runtime':'delivery-runtime'):'bot-runtime';
  const lease=await store.acquireLease(lane,crypto.randomUUID(),{now:now(),ttlMs:300000});
  if(!lease){message.retry({delaySeconds:2});return;}store.lease=lease;
  const start=now();
  try{
    await store.mutate("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?",id);
    await executeJob(store,env,job,fetchImpl);
    await store.mutate("UPDATE jobs SET status='done',done_ms=?,body_json='{}' WHERE id=?",now(),id);
    console.log(JSON.stringify({event:'job_complete',job_id:id,kind:job.kind,wall_ms:now()-start}));
    message.ack();
  }catch(error){
    const attempts=job.attempts+(error.noAttempt?0:1),wait=Math.min(86400,Math.max(1,error.delaySeconds||Math.min(900,30*2**job.attempts)));
    const failed=attempts>=5;
    try{await store.mutate('UPDATE jobs SET status=?,attempts=?,not_before=? WHERE id=?',failed?'failed':'pending',attempts,now()+wait*1000,id);
      if(failed&&job.kind==='refresh')await completeRefresh(store,id,false);
      if(failed&&job.kind==='command')await store.mutate('UPDATE interactive SET completed_ms=? WHERE id=?',now(),id);
      if(failed&&job.kind==='send'){
        const send=JSON.parse(job.body_json);await store.mutate("UPDATE outbox SET status='failed' WHERE id=?",send.outboxId);
        if(send.requestId)await store.mutate('UPDATE interactive SET completed_ms=? WHERE id=?',now(),send.requestId);
      }
    }catch{/* A new lease owner is responsible for recovery; never commit without ownership. */}
    console.log(JSON.stringify({event:'job_retry',job_id:id,kind:job.kind,attempts,failed,delay_seconds:wait,error_name:error.name,uncertain:!!error.uncertain}));
    if(failed)message.ack();else message.retry({delaySeconds:wait});
  }finally{
    if(env.DELIVERY&&job.kind==='refresh'){
      // A Queue hand-off has variable latency. Once prices are committed, release
      // the crawl lease and opportunistically deliver waiting replies here.
      // Another crawl consumer can proceed even while Telegram is slow.
      await store.releaseLease(lease).catch(()=>{});store.lease=null;
      const replies=(await store.statement("SELECT j.id FROM jobs j JOIN interactive i ON j.id=i.id||':reply' WHERE i.refresh_id=? AND j.status='pending' LIMIT 2",id).all()).results;
      for(const reply of replies){
        let retry;
        await consume({body:{jobId:reply.id},ack(){},retry(value){retry=value;}},env,{fetchImpl,now});
        if(retry)await env.DELIVERY.send({jobId:reply.id},{delaySeconds:retry.delaySeconds});
      }
    }
    try{await dispatch(store,env);}catch{console.log(JSON.stringify({event:'dispatch_failed',job_id:id}));}
    await store.releaseLease(lease).catch(()=>{});
    console.log(JSON.stringify({event:'job_resources',job_id:id,kind:job.kind,d1:measured.totals}));
  }
}
export default {
  async fetch(request,env){
    const store=new RuntimeStore(env.DB),url=new URL(request.url);
    if(url.pathname==='/health'){
      try{return json({ok:true,service:'air-ticket-telegram-worker',active:(await store.state('control',{active:false})).active});}
      catch{return json({ok:false},503);}
    }
    if(url.pathname==='/telegram'&&request.method==='POST'){
      return webhook(request,env,store);
    }
    if(url.pathname==='/sources/vna'&&request.method==='POST'){
      if(!env.VNA_FEED_SECRET||!equal(request.headers.get('x-vna-feed-secret'),env.VNA_FEED_SECRET))return json({error:'Unauthorized'},401);
      let record;try{record=validateFeed(await body(request),queryFrom(config),store.now());}catch{return json({error:'Invalid or stale agency feed'},400);}
      const changed=await store.statement(`INSERT INTO runtime_state(key,document_json) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json
        WHERE json_extract(runtime_state.document_json,'$.observed_at')<json_extract(excluded.document_json,'$.observed_at')`,feedKey(record.query),canonicalJson(record)).run();
      if(!changed.meta.changes)return json({accepted:true,duplicate:true});
      const state=await store.state('control',{active:false});
      if(state.active){await requestRefresh(store,'feed:'+Math.floor(Date.parse(record.observed_at)/600000),{force:true});await dispatch(store,env);}
      console.log(JSON.stringify({event:'agency_feed_received',source:record.source,status:record.status,age_ms:store.now()-Date.parse(record.observed_at)}));
      return json({accepted:true,status:record.status},202);
    }
    if(!url.pathname.startsWith('/admin/')||!admin(request,env))return json({error:'Not found'},404);
    if(url.pathname==='/admin/state'){
      const jobs=(await store.statement('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all()).results;
      const outbox=(await store.statement('SELECT status,COUNT(*) AS count FROM outbox GROUP BY status').all()).results;
      const subs=await store.statement('SELECT COUNT(*) AS count FROM subscribers WHERE active=1').first();
      const budget=env.OPTIMIZED==='1'?await store.statement('SELECT COUNT(*) AS accepted,200 AS limit_per_day FROM interactive WHERE day=?',new Date().toISOString().slice(0,10)).first():null;
      const policy=await store.state('quota-policy',{});if(budget&&policy.day===new Date().toISOString().slice(0,10))budget.limit_per_day=Math.min(200,policy.command_limit);
      return json({control:await store.state('control',{active:false}),jobs,outbox,active_subscribers:subs.count,budget});
    }
    if(url.pathname==='/admin/context')return json(await (await import('./jobs.mjs')).context(store));
    if(url.pathname==='/admin/job'){
      const id=url.searchParams.get('id');return json(await store.statement('SELECT id,kind,status,attempts,not_before FROM jobs WHERE id=?',id).first());
    }
    if(url.pathname==='/admin/activate'&&request.method==='POST'){
      const b=await body(request);if(typeof b.active!=='boolean')return json({error:'Invalid active value'},400);
      await store.putState('control',{active:b.active,changed_at:new Date().toISOString()});return json({active:b.active});
    }
    if(url.pathname==='/admin/enqueue'&&request.method==='POST'){
      const b=await body(request);if(!['crawl','retention','daily'].includes(b.kind))return json({error:'Invalid job'},400);
      const id='admin:'+crypto.randomUUID();await store.createJob(id,b.kind,{silent:b.silent!==false,preflight:!!b.preflight,
        ...(b.kind==='daily'?{day:localDay(Date.now())}:{} )});
      await dispatch(store,env);return json({job_id:id},202);
    }
    if(url.pathname==='/admin/recover'&&request.method==='POST')return json({enqueued:await dispatch(store,env)});
    return json({error:'Not found'},404);
  },
  async queue(batch,env){for(const message of batch.messages)await consume(message,env);},
  async scheduled(controller,env){
    const store=new RuntimeStore(env.DB),active=await store.state('control',{active:false});if(!active.active)return;
    const stamp=controller.scheduledTime,day=localDay(stamp);
    if(env.OPTIMIZED==='1'){
      const id='poll:'+Math.floor(stamp/600000),refresh=await requestRefresh(store,id,{force:true});
      // Both cron triggers share a slot. Persist daily delivery independently:
      // the refresh can already be done when the 07:00 trigger arrives.
      if(controller.cron==='0 0 * * *'&&config.monitoring.dailyReport)
        await store.createJob('daily:'+day,'daily',{day,refreshId:refresh?.id||id});
    }
    else if(controller.cron==='0 0 * * *'&&config.monitoring.dailyReport)await store.createJob('daily-crawl:'+day,'crawl',{day});
    else await store.createJob('poll:'+Math.floor(stamp/600000),'crawl',{});
    await store.createJob('retention:'+day,'retention',{});
    await dispatch(store,env);
    console.log(JSON.stringify({event:'cron_enqueued',slot:Math.floor(stamp/600000),daily:controller.cron==='0 0 * * *'}));
  },
};
