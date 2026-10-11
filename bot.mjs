import {mkdir,readFile,writeFile,rename,open,unlink,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {credentials,telegramCall,sendTelegram} from './lib/telegram.mjs';
import {handleCommand,commandMenu} from './lib/commands.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),creds=credentials(root),dir=path.join(root,'data');
if(!creds.enabled||!creds.configured){console.error('Bot chưa bật hoặc chưa đủ credentials.');process.exit(2);}
await mkdir(dir,{recursive:true});const lockFile=path.join(dir,'bot.lock');let lock;
try{lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));}catch(e){if(e.code==='EEXIST'){console.error('Bot đã chạy hoặc bot.lock cần kiểm tra PID.');process.exit(3);}throw e;}
let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
const file=path.join(dir,'bot-state.json'),key=createHash('sha256').update(creds.token.split(':')[0]+'|'+creds.chatId).digest('hex').slice(0,24);
try{
  let db={schema:1,entries:{}};try{db=JSON.parse(await readFile(file,'utf8'));if(db.schema!==1||!db.entries)throw new Error();}catch(e){if(e.code!=='ENOENT')throw new Error('Bot state không hợp lệ.');}
  const state=db.entries[key]||{offset:0,lastQuickAt:0},save=async()=>{db.entries[key]=state;await writeFile(file+'.tmp',JSON.stringify(db));await rename(file+'.tmp',file);};
  const me=await telegramCall(creds.token,'getMe');
  await telegramCall(creds.token,'setMyCommands',{commands:commandMenu,scope:{type:'chat',chat_id:creds.chatId}});
  console.log('Bot sẵn sàng: /price /report /status /help. Chỉ nhận lệnh từ chat riêng đã cấu hình.');
  while(!stopping){
    try{await access(path.join(dir,'watch.stop'));if(process.env.TRACKER_MANAGED==='1')break;}catch{}
    try{
      const updates=await telegramCall(creds.token,'getUpdates',{offset:state.offset,timeout:15,allowed_updates:['message']});
      for(const update of updates){
        if(stopping)break;if(update.update_id<state.offset)continue;
        state.offset=update.update_id+1;await save(); // At most once: an interrupted command may be sent again by the user.
        if(update.message?.date&&Date.now()/1000-update.message.date>300)continue;
        try{const result=await handleCommand({root,update,creds,state,save,username:me.username});if(result.status!=='ignored')console.log(JSON.stringify({at:new Date().toISOString(),...result}));}
        catch{console.error('Lệnh chưa hoàn tất; không ghi nội dung chat/credentials vào log.');if(update.message?.chat?.type==='private'&&String(update.message.chat.id)===creds.chatId)try{await sendTelegram(creds,'⚠️ Mình chưa hoàn tất được yêu cầu này. Bạn thử lại sau một chút nhé; lịch sử giá vẫn được giữ nguyên.');}catch{}}
      }
    }catch(e){console.error('Telegram đang gián đoạn hoặc có listener/webhook khác; chờ rồi thử lại.');const wait=Math.max(15,Math.min(86400,e.retryAfter||15));for(let i=0;i<wait&&!stopping;i++){await delay(1000);if(process.env.TRACKER_MANAGED==='1')try{await access(path.join(dir,'watch.stop'));stopping=true;}catch{}}}
  }
}catch{console.error('Không khởi động được bot; kiểm tra Telegram/config/state.');process.exitCode=1;}
finally{await lock.close();await unlink(lockFile);}
