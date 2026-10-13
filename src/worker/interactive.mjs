import {sendMessage} from './telegram.mjs';

export const DAILY_COMMAND_LIMIT=200;
export const CACHE_MS=30000;
const pricing=c=>['price','flights'].includes(c);

// Admission, replay protection and group coalescing are a single D1 transaction.
// Rejected requests create neither jobs nor a reply storm. Limits reset at UTC midnight.
export async function admit(store,botId,updateId,body){
  const now=store.now(),day=new Date(now).toISOString().slice(0,10),id='interactive:'+botId+':'+updateId;
  const replay=await store.statement('SELECT i.*,j.status FROM interactive i JOIN telegram_updates u ON u.job_id=i.id JOIN jobs j ON j.id=i.id WHERE u.bot_id=? AND u.update_id=?',botId,updateId).first();
  if(replay)return replay;
  const raw=await store.statement('SELECT COUNT(*) AS n FROM telegram_updates WHERE received_ms>=?',Date.parse(day)).first();
  if(raw.n>=1000)return null;
  const recent="bot_id=? AND chat_id=? AND command=? AND (completed_ms IS NULL OR created_ms>?)";
  const args=[botId,body.chatId,body.command,now-CACHE_MS];
  await store.db.batch([
    store.statement(`INSERT INTO interactive(id,bot_id,chat_id,command,day,created_ms)
      SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM interactive WHERE day=?)<?
      AND NOT EXISTS(SELECT 1 FROM telegram_updates WHERE bot_id=? AND update_id=?)
      AND NOT EXISTS(SELECT 1 FROM interactive WHERE ${recent}) ON CONFLICT DO NOTHING`,
      id,botId,body.chatId,body.command,day,now,day,DAILY_COMMAND_LIMIT,botId,updateId,...args),
    store.statement("INSERT INTO jobs(id,kind,body_json,created_ms) SELECT id,'command',?,created_ms FROM interactive WHERE id=? ON CONFLICT DO NOTHING",JSON.stringify({...body,optimized:true}),id),
    store.statement(`INSERT INTO telegram_updates(bot_id,update_id,job_id,received_ms)
      SELECT ?,?,id,? FROM interactive WHERE ${recent} ORDER BY created_ms DESC LIMIT 1 ON CONFLICT DO NOTHING`,botId,updateId,now,...args),
  ]);
  const row=await store.statement('SELECT i.*,j.status FROM interactive i JOIN telegram_updates u ON u.job_id=i.id JOIN jobs j ON j.id=i.id WHERE u.bot_id=? AND u.update_id=?',botId,updateId).first();
  return row;
}

export async function requestRefresh(store,id,{force=false,day=null}={}){
  const cache="SELECT json_extract(document_json,'$.id') FROM runtime_state WHERE key='refresh-cache' AND json_extract(document_json,'$.valid')=1 AND json_extract(document_json,'$.at')>?";
  await store.fencedBatch([
    store.statement(`INSERT INTO jobs(id,kind,body_json,created_ms)
      SELECT ?,'refresh',?,? WHERE (?=1 OR NOT EXISTS(${cache})) ON CONFLICT DO NOTHING`,id,JSON.stringify({optimized:true}),store.now(),Number(force),store.now()-CACHE_MS),
    ...(day?[store.statement("UPDATE jobs SET body_json=json_set(body_json,'$.day',?) WHERE kind='refresh' AND status IN ('pending','running')",day)]:[]),
  ]);
  return await store.statement(`SELECT id,status FROM jobs WHERE kind='refresh' AND status IN ('pending','running')
    UNION ALL SELECT id,status FROM jobs WHERE id=(${cache}) LIMIT 1`,store.now()-CACHE_MS).first();
}

export async function attachRefresh(store,requestId){
  await requestRefresh(store,requestId+':refresh');
  // A completed refresh is also eligible: this closes the join-vs-completion race.
  await store.mutate(`UPDATE interactive SET refresh_id=COALESCE(
    (SELECT id FROM jobs WHERE kind='refresh' AND status IN ('pending','running') LIMIT 1),
    (SELECT json_extract(document_json,'$.id') FROM runtime_state WHERE key='refresh-cache')) WHERE id=? AND refresh_id IS NULL`,requestId);
  const row=await store.statement('SELECT j.id,j.status FROM jobs j JOIN interactive i ON i.refresh_id=j.id WHERE i.id=?',requestId).first();
  if(!row)throw new Error('Refresh join missing');
  if(['done','failed'].includes(row.status))await queueReply(store,requestId);
  return row;
}

export async function queueReply(store,id){
  await store.mutate(`INSERT INTO jobs(id,kind,body_json,created_ms)
    SELECT id||':reply','reply',json_object('chatId',chat_id,'command',command,'requestId',id),?
    FROM interactive WHERE id=? AND completed_ms IS NULL ON CONFLICT DO NOTHING`,store.now(),id);
}

export async function completeRefresh(store,id,valid){
  await store.fencedBatch([
    store.statement("INSERT INTO runtime_state(key,document_json) VALUES('refresh-cache',?) ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json",JSON.stringify({id,at:store.now(),valid})),
    store.statement("UPDATE jobs SET status='done',done_ms=? WHERE id=?",store.now(),id),
    store.statement(`INSERT INTO jobs(id,kind,body_json,created_ms)
      SELECT id||':reply','reply',json_object('chatId',chat_id,'command',command,'requestId',id),?
      FROM interactive WHERE refresh_id=? AND completed_ms IS NULL ON CONFLICT DO NOTHING`,store.now(),id),
  ]);
}

// This path does no crawling/formatting. A durable ACK suppresses repeat loading.
// The delivery lease is shared with queued sends, independently of the crawl lease.
export async function fastLoading(store,env,id,fetchImpl=fetch){
  const r=await store.statement('SELECT * FROM interactive WHERE id=?',id).first();
  if(!r||!pricing(r.command)||r.loading_status==='sent'||r.completed_ms)return true;
  const lease=await store.acquireLease('telegram-delivery',crypto.randomUUID(),{now:store.now(),ttlMs:30000});
  if(!lease)return false;
  try{
    const again=await store.statement('SELECT loading_status FROM interactive WHERE id=?',id).first();
    if(again.loading_status==='sent')return true;
    const cooldown=await store.state('telegram-cooldown',{until:0});
    if(cooldown.until>store.now())return false;
    const text=r.command==='flights'?'⏳ Đang kiểm tra giờ bay và giá hai hãng, xong mình gửi ngay nhé...':'⏳ Đang kiểm tra giá mới hai hãng, xong mình gửi ngay nhé...';
    const sent=await sendMessage(env,r.chat_id,text,(url,options)=>fetchImpl(url,{...options,signal:AbortSignal.timeout(5000)}));
    if(!Number.isSafeInteger(sent?.message_id))throw new Error('Missing loading ACK');
    await store.db.batch([
      store.statement("UPDATE interactive SET loading_status='sent',loading_message_id=?,loading_ms=? WHERE id=?",sent.message_id,store.now(),id),
      store.statement("INSERT INTO runtime_state(key,document_json) VALUES('telegram-cooldown',?) ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json",JSON.stringify({until:store.now()+1100})),
    ]);
    console.log(JSON.stringify({event:'loading_complete',request_id:id,latency_ms:store.now()-r.created_ms}));return true;
  }catch(error){
    await store.putState('telegram-cooldown',{until:store.now()+(error.apiCode===429?error.retryAfter*1000:10000)});
    console.log(JSON.stringify({event:'loading_deferred',request_id:id,code:error.apiCode||0}));return false;
  }finally{await store.releaseLease(lease);}
}
