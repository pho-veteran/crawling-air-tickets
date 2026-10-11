import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {credentials,telegramCall,sendTelegram} from './lib/telegram.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
try {
  const c=credentials(root),command=process.argv[2]||'status';
  if(command==='status')console.log(JSON.stringify({enabled:c.enabled,tokenPresent:!!c.token,chatPresent:!!c.chatId,configured:c.configured},null,2));
  else if(command==='test'){
    const q=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
    await sendTelegram(c,'✅ Kết nối theo dõi vé thành công\n'+q.origin+' ⇄ '+q.destination+' | '+q.departureDate+' → '+q.returnDate+'\nLịch cấu hình: mỗi '+q.monitoring.pollMinutes+' phút, 24/7.\nĐây là tin thử; chưa xác nhận tiến trình theo dõi đang chạy.');
    console.log('Đã gửi tin thử Telegram.');
  }else if(command==='chat-id'){
    const updates=await telegramCall(c.token,'getUpdates',{timeout:0,allowed_updates:['message']});
    const chats=[...new Map(updates.filter(u=>u.message?.chat?.type==='private').map(u=>[u.message.chat.id,u.message.chat])).values()];
    console.log(chats.length?JSON.stringify(chats.map(c=>({chat_id:c.id,name:c.first_name,username:c.username})),null,2):'Hãy mở bot trong Telegram, bấm Start hoặc gửi tin nhắn, rồi chạy lại.');
  }else throw new Error('Lệnh hợp lệ: status, test, chat-id.');
}catch(e){console.error(e.message);process.exitCode=1;}
