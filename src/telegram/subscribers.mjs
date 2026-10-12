import {readFile, writeFile, rename, mkdir, open, unlink} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const privateChatId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const botId = token => token?.split(':')[0];
const stateFile = root => path.join(root, 'data', 'telegram-subscribers.json');

async function read(root) {
  try {
    const db = JSON.parse(await readFile(stateFile(root), 'utf8'));
    if (db.schema !== 1 || !db.bots || Array.isArray(db.bots) || typeof db.bots !== 'object') throw new Error();
    return db;
  } catch (error) {
    if (error.code === 'ENOENT') return {schema: 1, bots: {}};
    throw new Error('telegram-subscribers.json không hợp lệ; giữ nguyên để kiểm tra.');
  }
}

async function change(root, token, update) {
  const id = botId(token);
  if (!/^\d+$/.test(id || '')) throw new Error('Telegram chưa có bot token hợp lệ.');
  await mkdir(path.join(root, 'data'), {recursive: true});
  const lockFile = path.join(root, 'data', 'telegram-subscribers.lock');
  let lock;
  for (let attempt = 0; !lock; attempt++) {
    try {lock = await open(lockFile, 'wx'); await lock.writeFile(JSON.stringify({pid: process.pid}));}
    catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 50) throw new Error('Danh sách người nhận đang bị khóa; kiểm tra PID trong telegram-subscribers.lock.');
      await delay(100);
    }
  }
  try {
    const db = await read(root);
    const bot = db.bots[id] ??= {subscribers: {}, nextBroadcastAt: 0};
    if (!bot.subscribers || typeof bot.subscribers !== 'object' || Array.isArray(bot.subscribers)) throw new Error('Danh sách người nhận không hợp lệ.');
    const result = update(bot);
    await writeFile(stateFile(root) + '.tmp', JSON.stringify(db, null, 2));
    await rename(stateFile(root) + '.tmp', stateFile(root));
    return result;
  } finally {await lock.close(); await unlink(lockFile);}
}

export async function registerSubscriber({root, token, chatId, now = Date.now(), reactivate = false}) {
  if (!privateChatId(chatId)) throw new Error('Chỉ đăng ký private chat ID hợp lệ.');
  return change(root, token, bot => {
    const id = String(chatId), previous = bot.subscribers[id];
    const entry = bot.subscribers[id] = {...previous, active: previous ? (reactivate || previous.active) : true,
      subscribedAt: previous?.subscribedAt ?? now, lastSeenAt: now};
    if (reactivate) delete entry.stoppedAt;
    return {isNew: !previous, active: entry.active};
  });
}

export async function stopSubscriber({root, token, chatId, now = Date.now()}) {
  if (!privateChatId(chatId)) return;
  return change(root, token, bot => {
    bot.subscribers[String(chatId)] = {...bot.subscribers[String(chatId)], active: false, stoppedAt: now};
  });
}

export async function recipientState(root, creds) {
  const db = await read(root), bot = db.bots[botId(creds.token)];
  if (bot && (!bot.subscribers || typeof bot.subscribers !== 'object' || Array.isArray(bot.subscribers))) throw new Error('Danh sách người nhận không hợp lệ.');
  const subscribers = bot?.subscribers ?? {};
  const ids = new Set(Object.entries(subscribers).filter(([id, entry]) => privateChatId(id) && entry?.active === true).map(([id]) => id));
  // Honor existing installations with a fixed recipient, including their /stop preference.
  if (privateChatId(creds.chatId) && subscribers[String(creds.chatId)]?.active !== false) ids.add(String(creds.chatId));
  return {chatIds: [...ids], nextBroadcastAt: Number(bot?.nextBroadcastAt) || 0};
}

export const setBroadcastCooldown = (root, token, until) => change(root, token, bot => {
  bot.nextBroadcastAt = Math.max(Number(bot.nextBroadcastAt) || 0, until);
});
