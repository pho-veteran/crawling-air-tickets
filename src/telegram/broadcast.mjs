import {mkdir, open, unlink} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {recipientState, stopSubscriber, setBroadcastCooldown} from './subscribers.mjs';

export async function broadcast({root, creds, deliver, now = Date.now(), sleep = delay}) {
  if (!creds.enabled || !creds.configured) return {status: creds.enabled ? 'unconfigured' : 'disabled', recipients: 0};
  await mkdir(path.join(root, 'data'), {recursive: true});
  const lockFile = path.join(root, 'data', 'telegram-broadcast.lock');
  let lock;
  try {lock = await open(lockFile, 'wx'); await lock.writeFile(JSON.stringify({pid: process.pid}));}
  catch (error) {if (error.code === 'EEXIST') return {status: 'busy', recipients: 0}; throw error;}
  try {
    const {chatIds, nextBroadcastAt} = await recipientState(root, creds);
    if (!chatIds.length) return {status: 'no_subscribers', recipients: 0};
    if (now < nextBroadcastAt) return {status: 'retry_wait', recipients: chatIds.length, retryAfterSeconds: Math.ceil((nextBroadcastAt - now) / 1000)};
    const results = [];let needsPacing=false;
    for (const chatId of chatIds) {
      // A user may unsubscribe while a long broadcast is in progress.
      if (!(await recipientState(root, creds)).chatIds.includes(chatId)) continue;
      if(needsPacing)await sleep(1100);
      needsPacing=false;
      let result;
      try {result = await deliver({...creds, chatId});}
      catch (error) {result = {status: 'send_failed', blocked: error.apiCode === 403 || error.httpStatus === 403,
        rateLimited: error.apiCode === 429 || error.httpStatus === 429, retryAfterSeconds: error.retryAfter || 60};}
      results.push(result);
      needsPacing=['sent','send_failed'].includes(result.status);
      if (result.blocked) await stopSubscriber({root, token: creds.token, chatId, now});
      if (result.rateLimited) {
        await setBroadcastCooldown(root, creds.token, now + result.retryAfterSeconds * 1000);
        return {status: 'retry_wait', recipients: chatIds.length, processed: results.length, retryAfterSeconds: result.retryAfterSeconds};
      }
    }
    const statuses = results.map(r => r.status);
    const status = statuses.includes('send_failed') ? 'send_failed' : statuses.includes('retry_wait') ? 'retry_wait' :
      statuses.includes('busy') ? 'busy' : statuses.includes('sent') ? 'sent' : statuses[0] ?? 'no_subscribers';
    return {status, recipients: chatIds.length, processed: results.length, sent: results.filter(r => r.status === 'sent').length};
  } finally {await lock.close(); await unlink(lockFile);}
}
