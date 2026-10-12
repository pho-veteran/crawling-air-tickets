import {projectRoot} from '../shared/paths.mjs';
import {credentials,telegramCall} from '../telegram/client.mjs';
import {recipientState} from '../telegram/subscribers.mjs';
// Một lệnh check duy nhất: cấu hình, kết nối live, webhook và người đăng ký.
const root=projectRoot;
try {
  const c=credentials(root);
  if(!c.configured)throw new Error('Thiếu cấu hình Telegram trong .env (cần TELEGRAM_BOT_TOKEN).');
  const me=await telegramCall(c.token,'getMe');
  const hook=await telegramCall(c.token,'getWebhookInfo').catch(()=>({}));
  const subs=await recipientState(root,c);
  console.log(JSON.stringify({enabled:c.enabled,bot:me.username?'@'+me.username:null,
    webhook:hook.url||null,subscribers:subs.chatIds.length},null,2));
  if(hook.url)console.error('Lưu ý: bot đang gắn webhook, long polling sẽ không nhận tin.');
} catch(e){console.error('Telegram check thất bại: '+e.message);process.exitCode=1;}
