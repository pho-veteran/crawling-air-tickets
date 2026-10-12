import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from '../shared/paths.mjs';
import {credentials,telegramCall,sendTelegram} from '../telegram/client.mjs';
import {recipientState} from '../telegram/subscribers.mjs';
import {broadcast} from '../telegram/broadcast.mjs';
const root=projectRoot;
try {
  const c=credentials(root),command=process.argv[2]||'status';
  if(command==='status'){const subscribers=await recipientState(root,c);console.log(JSON.stringify({enabled:c.enabled,tokenPresent:!!c.token,chatPresent:!!c.chatId,configured:c.configured,subscribers:subscribers.chatIds.length},null,2));}
  else if(command==='test'){
    const q=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
    const text='✅ Kết nối theo dõi vé thành công\n'+q.origin+' ⇄ '+q.destination+' | '+q.departureDate+' → '+q.returnDate+'\nLịch cấu hình: mỗi '+q.monitoring.pollMinutes+' phút, 24/7.\nĐây là tin thử; chưa xác nhận tiến trình theo dõi đang chạy.';
    const result=await broadcast({root,creds:c,deliver:async recipient=>({status:'sent',messageId:await sendTelegram(recipient,text)})});
    console.log(JSON.stringify(result));if(['send_failed','retry_wait','busy','unconfigured','disabled'].includes(result.status))process.exitCode=1;
    if(result.status==='no_subscribers')console.log('Chưa có người nhận. Mở bot và gửi /start trước.');
  }else if(command==='chat-id'){
    const updates=await telegramCall(c.token,'getUpdates',{timeout:0,allowed_updates:['message']});
    const chats=[...new Map(updates.filter(u=>u.message?.chat?.type==='private').map(u=>[u.message.chat.id,u.message.chat])).values()];
    console.log(chats.length?JSON.stringify(chats.map(c=>({chat_id:c.id,name:c.first_name,username:c.username})),null,2):'Hãy mở bot trong Telegram, bấm Start hoặc gửi tin nhắn, rồi chạy lại.');
  }else throw new Error('Lệnh hợp lệ: status, test, chat-id.');
}catch(e){console.error(e.message);process.exitCode=1;}
