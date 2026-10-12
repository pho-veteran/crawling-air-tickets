import {canonicalJson,digest,observationModel} from './d1.mjs';

export const importFiles=['history.jsonl','telegram-subscribers.json','notification-state.json','daily-state.json','bot-state.json'];

// Pure planning: a broken input is rejected before any database write.
export function planImport(inputs) {
  const observations=[],documents=[],subscribers=[],occurrences=new Map(),minima=new Map(),sourceCounts=Object.create(null);
  const lines=(inputs['history.jsonl']?.text||'').split(/\r?\n/);
  for(let lineNumber=1;lineNumber<=lines.length;lineNumber++) {
    const line=lines[lineNumber-1];if(!line.trim())continue;
    let record,model;
    try {record=JSON.parse(line);model=observationModel(record);}
    catch {throw new Error('Invalid history record at line '+lineNumber+'; input was not changed.');}
    const hash=digest(model.recordJson),occurrence=(occurrences.get(hash)||0)+1;occurrences.set(hash,occurrence);
    observations.push({id:'import:'+hash+':'+occurrence,record,model});
    sourceCounts[model.source]=(sourceCounts[model.source]||0)+1;
    for(const quote of model.quotes) {
      const key=canonicalJson([quote.basisSource,quote.queryId,quote.kind,quote.departure,quote.back]),previous=minima.get(key);
      if(!previous||quote.price<previous.price||quote.price===previous.price&&quote.observedMs<previous.observedMs)minima.set(key,quote);
    }
  }
  for(const file of importFiles.slice(1)) {
    if(!inputs[file])continue;
    let document;
    try {document=JSON.parse(inputs[file].text);}
    catch {throw new Error('Invalid '+file+' JSON; input was not changed.');}
    const container=file==='telegram-subscribers.json'?'bots':file==='notification-state.json'?'accounts':'entries';
    if(document?.schema!==1||!document[container]||typeof document[container]!=='object'||Array.isArray(document[container]))throw new Error('Unsupported '+file+' schema.');
    documents.push({namespace:file,document,hash:inputs[file].hash||digest(inputs[file].text)});
    if(file==='telegram-subscribers.json')for(const [botId,bot] of Object.entries(document.bots)) {
      if(!/^[1-9]\d*$/.test(botId)||!bot.subscribers||typeof bot.subscribers!=='object'||Array.isArray(bot.subscribers))throw new Error('Invalid subscriber collection.');
      for(const [chatId,entry] of Object.entries(bot.subscribers)) {
        if(!/^[1-9]\d*$/.test(chatId)||!Number.isSafeInteger(Number(chatId))||typeof entry?.active!=='boolean')throw new Error('Invalid private subscriber.');
        subscribers.push({botId,chatId,entry});
      }
    }
  }
  return {observations,documents,subscribers,minima,summary:{observations:observations.length,
    quotes:observations.reduce((sum,o)=>sum+o.model.quotes.length,0),minima:minima.size,
    subscribers:subscribers.length,activeSubscribers:subscribers.filter(s=>s.entry.active).length,
    legacyDocuments:documents.length,sourceCounts}};
}

export async function applyImport(repository,plan) {
  // Do not import over a running bot's newer ACK/opt-out state. Use a fresh
  // destination, or an identical already-imported state for idempotent resume.
  const expectedObservations=new Map(plan.observations.map(o=>[o.id,o.model.recordJson]));
  const existingObservations=await repository.statement('SELECT id,record_json FROM observations').all();
  if(existingObservations.results.some(row=>expectedObservations.get(row.id)!==row.record_json))throw new Error('Destination contains different observations; use an isolated import database.');
  for(const item of plan.documents) {
    const existing=await repository.statement('SELECT source_sha256 FROM legacy_documents WHERE namespace=?',item.namespace).first();
    if(existing&&existing.source_sha256!==item.hash)throw new Error('Destination legacy state differs; reconcile before import.');
  }
  const existingSubscribers=await repository.statement('SELECT bot_id,chat_id,record_json FROM subscribers').all();
  const expectedSubscribers=new Map(plan.subscribers.map(s=>[s.botId+'|'+s.chatId,canonicalJson(s.entry)]));
  for(const row of existingSubscribers.results)if(expectedSubscribers.get(row.bot_id+'|'+row.chat_id)!==row.record_json)throw new Error('Destination subscriber state differs; opt-outs were preserved.');
  let inserted=0;
  for(const observation of plan.observations)inserted+=Number((await repository.putObservation(observation.id,observation.record)).inserted);
  for(const subscriber of plan.subscribers)await repository.putSubscriber(subscriber.botId,subscriber.chatId,subscriber.entry);
  for(const item of plan.documents)await repository.putLegacyDocument(item.namespace,item.document,item.hash);
  return {insertedObservations:inserted,...await verifyImport(repository,plan)};
}

export async function verifyImport(repository,plan) {
  const stored=await repository.statement('SELECT id,record_json FROM observations').all();
  const expected=new Map(plan.observations.map(o=>[o.id,o.model.recordJson]));
  if(stored.results.length!==expected.size||stored.results.some(r=>expected.get(r.id)!==r.record_json))throw new Error('Observation reconciliation failed.');
  const quotes=await repository.statement('SELECT COUNT(*) AS total FROM price_quotes').first();
  if(quotes.total!==plan.summary.quotes)throw new Error('Quote count reconciliation failed.');
  const minima=await repository.statement('SELECT * FROM price_minima').all();
  if(minima.results.length!==plan.minima.size)throw new Error('All-time minimum count reconciliation failed.');
  for(const row of minima.results) {
    const candidate=plan.minima.get(canonicalJson([row.basis_source,row.query_id,row.kind,row.departure_date,row.return_date]));
    if(!candidate||candidate.price!==row.price||candidate.observedMs!==row.observed_ms||candidate.detailsJson!==row.details_json)throw new Error('All-time minimum reconciliation failed.');
  }
  const subs=await repository.statement('SELECT * FROM subscribers').all();
  if(subs.results.length!==plan.summary.subscribers)throw new Error('Subscriber count reconciliation failed.');
  const subscriberMap=new Map(plan.subscribers.map(s=>[s.botId+'|'+s.chatId,s]));
  for(const row of subs.results) {
    const expected=subscriberMap.get(row.bot_id+'|'+row.chat_id);
    if(!expected||row.record_json!==canonicalJson(expected.entry)||row.active!==Number(expected.entry.active))throw new Error('Subscriber reconciliation failed.');
  }
  const documents=await repository.statement('SELECT * FROM legacy_documents').all();
  if(documents.results.length!==plan.summary.legacyDocuments)throw new Error('Legacy document count reconciliation failed.');
  const documentMap=new Map(plan.documents.map(d=>[d.namespace,d]));
  for(const row of documents.results) {
    const expected=documentMap.get(row.namespace);
    if(!expected||row.document_json!==canonicalJson(expected.document)||row.source_sha256!==expected.hash)throw new Error('Legacy cursor/ACK/cooldown reconciliation failed.');
  }
  return {verified:true,summary:plan.summary};
}
