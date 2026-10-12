// Explicit live smoke: real quotes, real Telegram deliveries; no fabricated history.
import path from 'node:path';
import {projectRoot} from '../src/shared/paths.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {credentials,sendTelegram} from '../src/telegram/client.mjs';
import {handleCommand} from '../src/telegram/commands.mjs';
import {loadContext} from '../src/reporting/context.mjs';
import {formatDaily} from '../src/monitoring/messages.mjs';
import {privateChatId} from '../src/telegram/subscribers.mjs';
const root=projectRoot;
const {values}=parseArgs({options:{send:{type:'boolean',default:false},'chat-id':{type:'string'}}});
if(!values.send){console.log('Dùng --send --chat-id <private chat ID> để crawl nhanh 1 lượt và gửi smoke /help /status /price + bản tin sáng.');process.exit(0);}
const base=credentials(root),creds={...base,chatId:values['chat-id']||base.chatId},state={},results=[],acks=[];
if(!privateChatId(creds.chatId))throw new Error('Smoke cần --chat-id <private chat ID> để gửi riêng cho người kiểm tra.');
const send=async(c,text)=>{const id=await sendTelegram(c,'🧪 Kiểm tra tính năng bot · dữ liệu giá thật\n\n'+text);acks.push({type:'text',id});await delay(1200);return id;};
try{
  for(const text of ['/help','/status','/price'])results.push(await handleCommand({root,creds,state,update:{message:{text,chat:{id:creds.chatId,type:'private'}}},send}));
  const c=await loadContext(root);await send(creds,formatDaily({...c,pollMinutes:c.settings.pollMinutes}));
  await mkdir(path.join(root,'data'),{recursive:true});await writeFile(path.join(root,'data','command-smoke-result.json'),JSON.stringify({at:new Date().toISOString(),status:'passed',results,acks},null,2));
  console.log(JSON.stringify({status:'passed',results,deliveries:acks.length}));
}catch{console.error('Command smoke chưa hoàn tất. Không tự gửi lại để tránh trùng.');process.exitCode=1;}
