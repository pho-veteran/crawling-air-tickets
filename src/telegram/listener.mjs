import {sendTelegram} from './client.mjs';
import {handleCommand} from './commands.mjs';
import {privateChatId, registerSubscriber, stopSubscriber} from './subscribers.mjs';

export async function handleIncomingUpdate({root, update, creds, state, save, username = '', now = Date.now,
  send = sendTelegram, handle = handleCommand}) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < (state.offset || 0)) return {status: 'ignored'};
  state.offset = update.update_id + 1;
  await save();
  const message = update.message;
  if (message?.chat?.type !== 'private' || !privateChatId(message.chat.id) || message.from?.is_bot) return {status: 'ignored'};
  const match = message.text?.trim().match(/^\/(\w+)(?:@(\w+))?(?:\s|$)/);
  if (match?.[2] && match[2].toLowerCase() !== username.toLowerCase()) return {status: 'ignored'};
  const command = match?.[1].toLowerCase();
  const recipient = {...creds, chatId: String(message.chat.id)};
  if (command === 'stop') await stopSubscriber({root, token: creds.token, chatId: recipient.chatId, now: now()});
  else {
    const subscription = await registerSubscriber({root, token: creds.token, chatId: recipient.chatId, now: now(), reactivate: command === 'start'});
    if (!match && subscription.isNew && (!message.date || now() / 1000 - message.date <= 300)) {
      await send(recipient, '👋 Bạn đã được đăng ký nhận cảnh báo giá và bản tin sáng của bot. /price để xem giá, /report để xem HTML, /stop để ngừng nhận, /start để nhận lại.');
    }
  }
  // Discover past contacts and honor their opt-out, but do not execute old commands.
  if (message.date && now() / 1000 - message.date > 300) return {status: 'expired'};
  return handle({root, update, creds: recipient, state, save, username, now, send});
}
