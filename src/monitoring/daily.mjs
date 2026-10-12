import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {credentials,sendTelegram} from '../telegram/client.mjs';
import {formatDaily,localDay,morningAt} from './messages.mjs';
import {broadcast} from '../telegram/broadcast.mjs';
export async function sendDaily(options){
  const creds=options.creds??credentials(options.root),now=options.now??Date.now();
  if(options.creds?.chatId||!creds.configured||!creds.enabled||!options.settings.dailyReport||now<morningAt(now,options.settings))return sendRecipient({...options,creds,now});
  return broadcast({root:options.root,creds,now,sleep:options.sleep,deliver:recipient=>sendRecipient({...options,creds:recipient,now})});
}
async function sendRecipient({root,providers,query,settings,now,creds,send=sendTelegram}){
  if(!settings.dailyReport)return {status:'disabled'};
  if(now<morningAt(now,settings))return {status:'not_due'};
  const dir=path.join(root,'data');await mkdir(dir,{recursive:true});
  const lockFile=path.join(dir,'daily.lock');let lock;
  try{lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));}catch(e){if(e.code==='EEXIST')return {status:'busy'};throw e;}
  try{
    const file=path.join(dir,'daily-state.json');let db={schema:1,entries:{}};
    try{db=JSON.parse(await readFile(file,'utf8'));if(db.schema!==1||!db.entries)throw new Error();}catch(e){if(e.code!=='ENOENT')throw new Error('daily-state.json không hợp lệ; chưa ghi đè.');}
    const key=createHash('sha256').update((creds.token?.split(':')[0]||'')+'|'+(creds.chatId||'')+'|'+JSON.stringify(query)).digest('hex').slice(0,24),day=localDay(now,settings.dailyUtcOffset);
    const entry=db.entries[key]?.day===day?db.entries[key]:{day,sent:false,attempts:0,nextAttemptAt:0};
    if(entry.sent)return {status:'already_sent',day};
    // Keep recipient ACKs when upgrading from text + attachment delivery.
    // Unsent legacy text is rebuilt without the old HTML/footer instructions.
    const message=entry.messageVersion===2&&entry.message||formatDaily({providers,query,now,pollMinutes:settings.pollMinutes,settings});
    delete entry.reportFile;delete entry.reportId;
    await writeFile(path.join(dir,'daily-preview.txt'),message,'utf8');
    if(!creds.enabled||!creds.configured)return {status:creds.enabled?'unconfigured':'disabled'};
    if(now<entry.nextAttemptAt)return {status:'retry_wait',retryAfterSeconds:Math.ceil((entry.nextAttemptAt-now)/1000)};
    const save=async()=>{db.entries[key]=entry;await writeFile(file+'.tmp',JSON.stringify(db,null,2));await rename(file+'.tmp',file);};
    await save();
    try{
      entry.message=message;entry.messageVersion=2;await save();
      if(!entry.messageId){entry.messageId=await send(creds,message);await save();}
    }
    catch(e){entry.attempts++;const wait=Math.max(300,Math.min(21600,300*2**Math.min(entry.attempts-1,7)),e.retryAfter||0);entry.nextAttemptAt=now+wait*1000;await save();return {status:'send_failed',retryAfterSeconds:wait,blocked:e.apiCode===403||e.httpStatus===403,rateLimited:e.apiCode===429||e.httpStatus===429};}
    entry.sent=true;entry.sent_at=new Date(now).toISOString();entry.attempts=0;entry.nextAttemptAt=0;await save();
    return {status:'sent',day,messageId:entry.messageId};
  }finally{await lock.close();await unlink(lockFile);}
}
