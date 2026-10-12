import {createHash} from 'node:crypto';

export const digest=value=>createHash('sha256').update(value).digest('hex');
export function canonicalJson(value) {
  if(Array.isArray(value))return '['+value.map(item=>canonicalJson(item)??'null').join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
const hasPrice=value=>Number.isSafeInteger(value)&&value>0;
const assertPrice=value=>{if(value!==null&&value!==undefined&&!hasPrice(value))throw new Error('Invalid historical price; no data was discarded.');};
const timestamp=value=>{const ms=Date.parse(value);if(!Number.isSafeInteger(ms)||ms<0)throw new Error('Invalid observation timestamp.');return ms;};
const date=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value||'')||!Number.isFinite(Date.parse(value))||new Date(Date.parse(value)).toISOString().slice(0,10)!==value)throw new Error('Invalid quote date.');return value;};
const text=(value,label)=>{if(typeof value!=='string'||!value||value.length>200)throw new Error('Invalid '+label+'.');return value;};

export function observationModel(record) {
  if(record?.schema!==1||!['ok','partial','error'].includes(record.status))throw new Error('Unsupported observation schema/status.');
  const source=text(record.source,'source'),queryId=text(record.query_id,'query ID'),observedMs=timestamp(record.observed_at);
  if(!record.query)throw new Error('Missing observation query.');
  const mainDeparture=date(record.query.departureDate),mainReturn=date(record.query.returnDate);
  assertPrice(record.main_price);
  const quotes=[],keys=new Set();
  const add=(basisSource,kind,departure,back,price,at,details)=>{
    assertPrice(price);if(!hasPrice(price))return;
    const key=kind+'|'+departure+'|'+back;
    if(keys.has(key))throw new Error('Duplicate quote dimension in observation.');
    keys.add(key);quotes.push({basisSource,queryId,kind,departure,back,price,observedMs:timestamp(at),detailsJson:canonicalJson(details)});
  };
  for(const cell of record.cells||[]) {
    assertPrice(cell.price);date(cell.depart);date(cell.return);
    if(record.status!=='error')add(source,'roundtrip',cell.depart,cell.return,cell.price,record.observed_at,cell);
  }
  if(record.status!=='error'&&hasPrice(record.main_price)) {
    const main=quotes.find(q=>q.kind==='roundtrip'&&q.departure===mainDeparture&&q.back===mainReturn);
    if(main&&main.price!==record.main_price)throw new Error('Main price differs from its calendar cell.');
    if(!main)add(source,'roundtrip',mainDeparture,mainReturn,record.main_price,record.observed_at,{main_price:record.main_price});
  }
  const legSource=text(record.legs_source||source,'leg source');
  for(const kind of ['outbound','inbound'])for(const quote of record.legs?.[kind]||[]) {
    date(quote.date);assertPrice(quote.price);
    if(record.status!=='error')add(legSource,kind,quote.date,'',quote.price,quote.observed_at||record.observed_at,quote);
  }
  // Error records are kept intact but never become zero-price/minimum candidates.
  return {source,queryId,observedMs,status:record.status,recordJson:canonicalJson(record),quotes};
}

// Both D1 and the offline SQLite adapter expose prepare/bind/batch/all/first.
// Queries stay under D1's 100-bind limit. An observation is written atomically.
export class D1Repository {
  constructor(db){this.db=db;}
  statement(sql,...values){return this.db.prepare(sql).bind(...values);}
  async putObservation(id,record) {
    text(id,'observation ID');const model=observationModel(record);
    const statements=[this.statement(`INSERT INTO observations(id,source,query_id,observed_ms,status,record_json)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,id,model.source,model.queryId,model.observedMs,model.status,model.recordJson)];
    // Nine bound columns/row plus two guard binds: at most 92 parameters.
    for(let i=0;i<model.quotes.length;i+=10) {
      const rows=model.quotes.slice(i,i+10),values=rows.flatMap(q=>[id,q.basisSource,q.queryId,q.kind,q.departure,q.back,q.price,q.observedMs,q.detailsJson]);
      const placeholders=rows.map(()=>'(?,?,?,?,?,?,?,?,?)').join(',');
      // Multi-row VALUES avoids D1's five-term compound SELECT limit.
      statements.push(this.statement(`WITH incoming(observation_id,basis_source,query_id,kind,departure_date,return_date,price,observed_ms,details_json)
        AS (VALUES ${placeholders}) INSERT INTO price_quotes SELECT incoming.* FROM incoming
        WHERE EXISTS(SELECT 1 FROM observations WHERE id=? AND record_json=?)
        ON CONFLICT(observation_id,kind,departure_date,return_date) DO NOTHING`,...values,id,model.recordJson));
    }
    statements.push(this.statement(`INSERT INTO price_minima
      SELECT basis_source,query_id,kind,departure_date,return_date,price,observed_ms,details_json FROM price_quotes
      WHERE observation_id=? AND EXISTS(SELECT 1 FROM observations WHERE id=? AND record_json=?)
      ON CONFLICT(basis_source,query_id,kind,departure_date,return_date) DO UPDATE SET
        price=excluded.price,observed_ms=excluded.observed_ms,details_json=excluded.details_json
      WHERE excluded.price<price_minima.price OR
        (excluded.price=price_minima.price AND excluded.observed_ms<price_minima.observed_ms)`,id,id,model.recordJson));
    if(statements.length>45)throw new Error('Observation exceeds the Free query budget; split persistence before deployment.');
    const results=await this.db.batch(statements);
    const stored=await this.statement('SELECT record_json FROM observations WHERE id=?',id).first();
    if(stored?.record_json!==model.recordJson)throw new Error('Observation ID collision; existing history was preserved.');
    return {inserted:results[0].meta.changes>0,quotes:model.quotes.length,statements:statements.length+1};
  }
  async historyPage({source,queryId,limit=50,after=null}) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('History page limit must be 1–100.');
    const result=after?await this.statement(`SELECT id,observed_ms,record_json FROM observations
      WHERE source=? AND query_id=? AND (observed_ms>? OR (observed_ms=? AND id>?))
      ORDER BY observed_ms,id LIMIT ?`,source,queryId,after.observed_ms,after.observed_ms,after.id,limit).all():
      await this.statement(`SELECT id,observed_ms,record_json FROM observations WHERE source=? AND query_id=?
        ORDER BY observed_ms,id LIMIT ?`,source,queryId,limit).all();
    return {records:result.results.map(r=>JSON.parse(r.record_json)),cursor:result.results.length?{id:result.results.at(-1).id,observed_ms:result.results.at(-1).observed_ms}:null};
  }
  async minimum({basisSource,queryId,kind,departure,back='',fromMs=null,throughMs=Date.now()}) {
    const prefix=[basisSource,queryId,kind,departure,back];
    const row=fromMs===null?await this.statement(`SELECT price,observed_ms,details_json FROM price_minima
      WHERE basis_source=? AND query_id=? AND kind=? AND departure_date=? AND return_date=?`,...prefix).first():
      await this.statement(`SELECT price,observed_ms,details_json FROM price_quotes
        WHERE basis_source=? AND query_id=? AND kind=? AND departure_date=? AND return_date=? AND observed_ms>=? AND observed_ms<=?
        ORDER BY price,observed_ms LIMIT 1`,...prefix,fromMs,throughMs).first();
    return row?{price:row.price,observed_at:new Date(row.observed_ms).toISOString(),details:JSON.parse(row.details_json)}:null;
  }
  async pruneBefore(beforeMs,limit=100) {
    if(!Number.isSafeInteger(beforeMs)||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('Invalid retention bounds.');
    const result=await this.statement(`DELETE FROM observations WHERE id IN
      (SELECT id FROM observations WHERE observed_ms<? ORDER BY observed_ms,id LIMIT ?)`,beforeMs,limit).run();
    return result.meta.changes;
  }
  async putSubscriber(botId,chatId,entry) {
    if(!/^[1-9]\d*$/.test(String(botId))||!/^[1-9]\d*$/.test(String(chatId))||!Number.isSafeInteger(Number(chatId))||typeof entry?.active!=='boolean')throw new Error('Invalid private subscriber record.');
    return this.statement(`INSERT INTO subscribers(bot_id,chat_id,active,record_json) VALUES(?,?,?,?)
      ON CONFLICT(bot_id,chat_id) DO UPDATE SET active=excluded.active,record_json=excluded.record_json`,String(botId),String(chatId),Number(entry.active),canonicalJson(entry)).run();
  }
  async putLegacyDocument(namespace,document,sourceHash) {
    if(!/^[a-f0-9]{64}$/.test(sourceHash))throw new Error('Invalid legacy document hash.');
    return this.statement(`INSERT INTO legacy_documents(namespace,source_sha256,document_json) VALUES(?,?,?)
      ON CONFLICT(namespace) DO UPDATE SET source_sha256=excluded.source_sha256,document_json=excluded.document_json`,text(namespace,'legacy namespace'),sourceHash,canonicalJson(document)).run();
  }
  async acquireLease(resource,owner,{now=Date.now(),ttlMs=90000}={}) {
    text(resource,'lease resource');text(owner,'lease owner');
    if(!Number.isSafeInteger(now)||!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>900000)throw new Error('Invalid lease time.');
    return this.statement(`INSERT INTO leases(resource,owner,epoch,expires_ms) VALUES(?,?,1,?)
      ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,epoch=leases.epoch+1,expires_ms=excluded.expires_ms
      WHERE leases.expires_ms<=? RETURNING resource,owner,epoch,expires_ms`,resource,owner,now+ttlMs,now).first();
  }
  async renewLease(lease,{now=Date.now(),ttlMs=90000}={}) {
    if(!Number.isSafeInteger(now)||!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>900000)throw new Error('Invalid lease time.');
    return this.statement(`UPDATE leases SET expires_ms=? WHERE resource=? AND owner=? AND epoch=? AND expires_ms>?
      RETURNING resource,owner,epoch,expires_ms`,now+ttlMs,lease.resource,lease.owner,lease.epoch,now).first();
  }
  async releaseLease(lease) {
    // Keep the row as a tombstone so reusing the same owner cannot reuse an epoch.
    return (await this.statement(`UPDATE leases SET expires_ms=0 WHERE resource=? AND owner=? AND epoch=? AND expires_ms>0`,lease.resource,lease.owner,lease.epoch).run()).meta.changes===1;
  }
}
