// Explicit live smoke: real quotes, real Telegram deliveries; no fabricated history.
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {credentials,sendTelegram,sendDocument} from './lib/telegram.mjs';
import {handleCommand} from './lib/commands.mjs';
import {loadContext,makeReport} from './lib/context.mjs';
import {formatDaily} from './lib/messages.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
if(!process.argv.includes('--send')){console.log('Dùng --send để crawl nhanh 1 lượt và gửi smoke /help /status /price /report + bản tin sáng kèm HTML.');process.exit(0);}
const creds=credentials(root),state={},results=[],acks=[];
const send=async(c,text)=>{const id=await sendTelegram(c,'🧪 Kiểm tra tính năng bot · dữ liệu giá thật\n\n'+text);acks.push({type:'text',id});await delay(1200);return id;};
const attach=async(c,file,caption)=>{const id=await sendDocument(c,file,'🧪 Kiểm tra gửi HTML\n'+caption);acks.push({type:'document',id});await delay(1200);return id;};
try{
  for(const text of ['/help','/status','/price','/report'])results.push(await handleCommand({root,creds,state,update:{message:{text,chat:{id:creds.chatId,type:'private'}}},send,attach}));
  const c=await loadContext(root);await send(creds,formatDaily({...c,pollMinutes:c.settings.pollMinutes}));await attach(creds,await makeReport(root,c),'Mẫu bản tin sáng — dùng giá đã lưu, không đánh dấu bản tin hằng ngày đã gửi.');
  await mkdir(path.join(root,'data'),{recursive:true});await writeFile(path.join(root,'data','command-smoke-result.json'),JSON.stringify({at:new Date().toISOString(),status:'passed',results,acks},null,2));
  console.log(JSON.stringify({status:'passed',results,deliveries:acks.length}));
}catch{console.error('Command smoke chưa hoàn tất. Không tự gửi lại để tránh trùng.');process.exitCode=1;}
