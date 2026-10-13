import {D1Repository,canonicalJson,digest,observationModel} from '../storage/d1.mjs';

export const sqlNow="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export class LostLease extends Error {constructor(){super('Lease ownership lost');this.name='LostLease';}}
export class RuntimeStore extends D1Repository {
  constructor(db,{now=Date.now}={}){super(db);this.now=now;this.lease=null;}
  async state(key,fallback={}){const r=await this.statement('SELECT document_json FROM runtime_state WHERE key=?',key).first();return r?JSON.parse(r.document_json):fallback;}
  async putState(key,value){return this.mutate(`INSERT INTO runtime_state(key,document_json) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json`,key,canonicalJson(value));}
  async mutate(sql,...values){
    if(!this.lease)return this.statement(sql,...values).run();
    // A CHECK constraint aborts the whole D1 transaction before any stale-owner mutation.
    const l=this.lease;
    const guard=this.statement(`INSERT INTO runtime_state(key,document_json)
      SELECT 'fence-check',CASE WHEN EXISTS(SELECT 1 FROM leases WHERE resource=? AND owner=? AND epoch=? AND expires_ms>${sqlNow})
      THEN '{}' ELSE 'invalid-json' END ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json`,l.resource,l.owner,l.epoch);
    const result=await this.db.batch([guard,this.statement(sql,...values)]);return result[1];
  }
  async fencedBatch(statements){
    if(!this.lease)return this.db.batch(statements);
    const l=this.lease;
    const guard=this.statement(`INSERT INTO runtime_state(key,document_json)
      SELECT 'fence-check',CASE WHEN EXISTS(SELECT 1 FROM leases WHERE resource=? AND owner=? AND epoch=? AND expires_ms>${sqlNow})
      THEN '{}' ELSE 'invalid-json' END ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json`,l.resource,l.owner,l.epoch);
    return (await this.db.batch([guard,...statements])).slice(1);
  }
  async assertOwner(){
    if(!this.lease)throw new LostLease();
    const lease=await this.renewLease(this.lease,{now:this.now(),ttlMs:300000});if(!lease)throw new LostLease();this.lease=lease;
  }
  commitBatch(statements){return this.fencedBatch(statements);}
  observe(id,record){return this.putObservation(id,record);}
  async observeCurrent(record){
    const prior=await this.latest(record.source,record.query_id);
    let current={...record,history_mode:'current-and-minimum',last_attempt_failed:record.status==='error'};
    if(record.status==='error'&&prior&&['ok','partial'].includes(prior.status))current={...prior,job_id:record.job_id,
      history_mode:'current-and-minimum',last_attempt_failed:true,last_attempt_at:record.observed_at,
      last_attempt_error:record.error,consecutive_errors:(prior.consecutive_errors||0)+1};
    if(record.status!=='error')current.consecutive_errors=0;
    const model=observationModel(current),id='current:'+model.source+':'+model.queryId;
    const statements=[this.statement(`INSERT INTO observations(id,source,query_id,observed_ms,status,record_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET observed_ms=excluded.observed_ms,status=excluded.status,record_json=excluded.record_json`,
      id,model.source,model.queryId,model.observedMs,model.status,model.recordJson)];
    for(const q of model.quotes.filter(q=>q.departure===(q.kind==='inbound'?current.query.returnDate:current.query.departureDate)&&q.back===(q.kind==='roundtrip'?current.query.returnDate:'')))statements.push(this.statement(`INSERT INTO price_minima(basis_source,query_id,kind,departure_date,return_date,price,observed_ms,details_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(basis_source,query_id,kind,departure_date,return_date) DO UPDATE SET
      price=excluded.price,observed_ms=excluded.observed_ms,details_json=excluded.details_json
      WHERE excluded.price<price_minima.price`,q.basisSource,q.queryId,q.kind,q.departure,q.back,q.price,q.observedMs,canonicalJson(q.kind==='roundtrip'?{main_price:q.price}:{date:q.departure,price:q.price})));
    // Current replaces current; no time-series quotes or observations are appended.
    statements.push(this.statement('DELETE FROM observations WHERE source=? AND query_id=? AND id<>?',model.source,model.queryId,id));
    await this.fencedBatch(statements);return current;
  }
  async createJob(id,kind,body,{notBefore=0}={}){
    await this.mutate('INSERT INTO jobs(id,kind,body_json,not_before,created_ms) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,kind,canonicalJson(body),notBefore,this.now());
    return id;
  }
  async receiveUpdate(botId,updateId,body){
    const id='update:'+botId+':'+updateId;
    await this.db.batch([
      this.statement("INSERT INTO jobs(id,kind,body_json,created_ms) VALUES(?,'command',?,?) ON CONFLICT(id) DO NOTHING",id,canonicalJson(body),this.now()),
      this.statement('INSERT INTO telegram_updates(bot_id,update_id,job_id,received_ms) VALUES(?,?,?,?) ON CONFLICT(bot_id,update_id) DO NOTHING',botId,updateId,id,this.now()),
      this.statement(`INSERT INTO subscribers(bot_id,chat_id,active,record_json,last_update_id) VALUES(?,?,?,?,?)
        ON CONFLICT(bot_id,chat_id) DO UPDATE SET
        active=CASE WHEN ?='stop' THEN 0 WHEN ?='start' THEN 1 ELSE subscribers.active END,
        record_json=json_set(subscribers.record_json,'$.active',json(CASE WHEN ?='stop' THEN 'false' WHEN ?='start' THEN 'true' ELSE CASE WHEN subscribers.active=1 THEN 'true' ELSE 'false' END END),
          '$.lastSeenAt',?),last_update_id=excluded.last_update_id
        WHERE excluded.last_update_id>subscribers.last_update_id`,botId,body.chatId,body.command==='stop'?0:1,
        canonicalJson({active:body.command!=='stop',subscribedAt:this.now(),lastSeenAt:this.now()}),updateId,body.command,body.command,body.command,body.command,this.now()),
    ]);
    return id;
  }
  async history(source,queryId,limit=30){
    const result=await this.statement('SELECT record_json FROM observations WHERE source=? AND query_id=? ORDER BY observed_ms DESC,id DESC LIMIT ?',source,queryId,limit).all();
    return result.results.map(r=>JSON.parse(r.record_json)).reverse();
  }
  async latest(source,queryId){return (await this.history(source,queryId,1))[0];}
  async subscribers(botId,after=''){return (await this.statement('SELECT chat_id FROM subscribers WHERE bot_id=? AND active=1 AND chat_id>? ORDER BY chat_id LIMIT 15',botId,after).all()).results.map(r=>r.chat_id);}
  async subscriber(botId,chatId,command){
    const row=await this.statement('SELECT record_json FROM subscribers WHERE bot_id=? AND chat_id=?',botId,chatId).first();
    const before=row?JSON.parse(row.record_json):null;
    const entry={...before,active:command==='stop'?false:command==='start'?true:before?.active??true,
      subscribedAt:before?.subscribedAt??this.now(),lastSeenAt:this.now()};
    if(command==='stop')entry.stoppedAt=this.now();if(command==='start')delete entry.stoppedAt;
    await this.mutate(`INSERT INTO subscribers(bot_id,chat_id,active,record_json) VALUES(?,?,?,?)
      ON CONFLICT(bot_id,chat_id) DO UPDATE SET active=excluded.active,record_json=excluded.record_json`,botId,chatId,Number(entry.active),canonicalJson(entry));
  }
  async queueText(id,chatId,text,{kind='manual',guards=[],stateKey=null,notBefore=0}={}){
    await this.mutate(`INSERT INTO outbox(id,chat_id,kind,message,guards_json,state_key,created_ms,not_before)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,id,chatId,kind,text,canonicalJson(guards),stateKey,this.now(),notBefore);
    return this.createJob('send:'+digest(id),'send',{outboxId:id},{notBefore});
  }
}
