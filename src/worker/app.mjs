import {timingSafeEqual} from 'node:crypto';
import {RuntimeStore} from './runtime-store.mjs';
import {executeJob,context,settings} from './jobs.mjs';
import {localDay} from '../monitoring/messages.mjs';
import {meter} from './d1-meter.mjs';
import {admit,requestRefresh,completeRefresh,fastLoading} from './interactive.mjs';

const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const equal=(a,b)=>{const x=new TextEncoder().encode(a||''),y=new TextEncoder().encode(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const admin=(r,env)=>!!env.ADMIN_SECRET&&equal(r.headers.get('authorization'),'Bearer '+env.ADMIN_SECRET);
async function body(request){
  const reader=request.body?.getReader();if(!reader)return {};
  const chunks=[];let bytes=0;
  try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>65536)throw new Error('body size');chunks.push(r.value);}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function dispatch(store,env){
  const rows=(await store.statement("SELECT id FROM jobs WHERE status IN ('pending','running') AND not_before<=? AND queued_ms<? ORDER BY created_ms,id LIMIT 15",store.now(),store.now()-60000).all()).results;
  if(!rows.length)return 0;
  await env.JOBS.sendBatch(rows.map(r=>({body:{jobId:r.id}})));
  await store.mutate('UPDATE jobs SET queued_ms=? WHERE id IN ('+rows.map(()=>'?').join(',')+')',store.now(),...rows.map(r=>r.id));
  return rows.length;
}
export async function webhook(request,env,store){
  if(!env.WEBHOOK_SECRET||!equal(request.headers.get('x-telegram-bot-api-secret-token'),env.WEBHOOK_SECRET))return json({error:'Unauthorized'},401);
  const control=await store.state('control',{active:false});if(!control.active)return json({error:'Temporarily inactive'},503);
  let u;try{u=await body(request);}catch{return json({error:'Invalid update'},400);}
  if(!Number.isSafeInteger(u.update_id)||u.update_id<0)return json({error:'Invalid update ID'},400);
  const floor=await store.state('telegram-min-update',{offset:0});if(u.update_id<floor.offset)return json({ok:true});
  const m=u.message,shared=await store.state('shared-chat',{});
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
      const accepted=await admit(store,env.TELEGRAM_BOT_TOKEN.split(':')[0],u.update_id,{chatId:String(m.chat.id),command,shared:!!shared.chatId,group});
      if(accepted?.status==='pending')await dispatch(store,env);
      return json({ok:true});
    }
    const id=await store.receiveUpdate(env.TELEGRAM_BOT_TOKEN.split(':')[0],u.update_id,{chatId:String(m.chat.id),command,shared:!!shared.chatId,group}, {subscribe:!shared.chatId});
    await env.JOBS.send({jobId:id});
  }catch{console.log(JSON.stringify({event:'webhook_persistence_failed'}));return json({error:'Persistence unavailable'},503);}
  return json({ok:true});
}
export async function consume(message,env,{fetchImpl=fetch,now=Date.now}={}){
  const measured=meter(env.DB),store=new RuntimeStore(measured.db,{now}),id=message.body?.jobId;
  if(typeof id!=='string'||id.length>250){message.ack();return;}
  const job=await store.statement('SELECT * FROM jobs WHERE id=?',id).first();
  if(!job||['done','failed'].includes(job.status)){message.ack();return;}
  const control=await store.state('control',{active:false});
  if(!control.active&&!JSON.parse(job.body_json).preflight){message.retry({delaySeconds:60});return;}
  if(job.not_before>now()){message.retry({delaySeconds:Math.min(86400,Math.ceil((job.not_before-now())/1000))});return;}
  const lease=await store.acquireLease('bot-runtime',crypto.randomUUID(),{now:now(),ttlMs:300000});
  if(!lease){message.retry({delaySeconds:10});return;}store.lease=lease;
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
      if(failed&&job.kind==='send')await store.mutate("UPDATE outbox SET status='failed' WHERE id=?",JSON.parse(job.body_json).outboxId);
    }catch{/* A new lease owner is responsible for recovery; never commit without ownership. */}
    console.log(JSON.stringify({event:'job_retry',job_id:id,kind:job.kind,attempts,failed,delay_seconds:wait,error_name:error.name,uncertain:!!error.uncertain}));
    if(failed)message.ack();else message.retry({delaySeconds:wait});
  }finally{
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
    if(url.pathname==='/telegram'&&request.method==='POST')return webhook(request,env,store);
    if(!url.pathname.startsWith('/admin/')||!admin(request,env))return json({error:'Not found'},404);
    if(url.pathname==='/admin/state'){
      const jobs=(await store.statement('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all()).results;
      const outbox=(await store.statement('SELECT status,COUNT(*) AS count FROM outbox GROUP BY status').all()).results;
      const subs=await store.statement('SELECT COUNT(*) AS count FROM subscribers WHERE active=1').first();
      return json({control:await store.state('control',{active:false}),jobs,outbox,active_subscribers:subs.count});
    }
    if(url.pathname==='/admin/context')return json(await context(store));
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
    if(env.OPTIMIZED==='1')await requestRefresh(store,'poll:'+Math.floor(stamp/600000),{force:true,day:controller.cron==='0 0 * * *'&&settings.dailyReport?day:null});
    else if(controller.cron==='0 0 * * *'&&settings.dailyReport)await store.createJob('daily-crawl:'+day,'crawl',{day});
    else await store.createJob('poll:'+Math.floor(stamp/600000),'crawl',{});
    await store.createJob('retention:'+day,'retention',{});
    await dispatch(store,env);
    console.log(JSON.stringify({event:'cron_enqueued',slot:Math.floor(stamp/600000),daily:controller.cron==='0 0 * * *'}));
  },
};
