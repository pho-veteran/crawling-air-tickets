import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {registerSubscriber, stopSubscriber, recipientState} from '../src/telegram/subscribers.mjs';
import {broadcast} from '../src/telegram/broadcast.mjs';
import {handleIncomingUpdate} from '../src/telegram/listener.mjs';
import {handleCommand} from '../src/telegram/commands.mjs';
import {telegramCall, credentials} from '../src/telegram/client.mjs';
import {notifyRecord} from '../src/monitoring/notify.mjs';
import {sendDaily} from '../src/monitoring/daily.mjs';
import {settingsFrom} from '../src/monitoring/alerts.mjs';

const creds = {token: '123:TEST_SECRET', enabled: true, configured: true};
const query = {origin: 'SGN', destination: 'VCL', departureDate: '2027-02-04', returnDate: '2027-02-13', adults: 1};
const settings = settingsFrom({priceOnly: true}, {});
const now = Date.parse('2026-10-12T07:00:00+07:00');
const provider = {id: 'vietjet', name: 'Vietjet', source: 'vietjet-public-calendar-v1'};
const record = (at, main = 4200000) => ({schema: 1, query, query_id: 'test', source: provider.source, status: 'ok',
  observed_at: new Date(at).toISOString(), main_price: main, minimum_price: main, cells: [],
  legs: {outbound: [{date: query.departureDate, price: 1800000}], inbound: [{date: query.returnDate, price: 2400000}]}});
const sleep = async () => {};

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fare-broadcast-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}
const enroll = (root, chatId, options = {}) => registerSubscriber({root, token: creds.token, chatId, ...options});

test('token alone configures the bot without a fixed chat ID', async t => {
  const root = await workspace(t), originalToken = process.env.TELEGRAM_BOT_TOKEN, originalChat = process.env.TELEGRAM_CHAT_ID;
  t.after(() => {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = originalChat;
  });
  process.env.TELEGRAM_BOT_TOKEN = creds.token;
  delete process.env.TELEGRAM_CHAT_ID;
  assert.equal(credentials(root).configured, true);
  assert.equal(credentials(root).chatId, undefined);
});

test('subscribers survive restart, concurrent registration, bot separation and opt-out', async t => {
  const root = await workspace(t);
  await Promise.all(['111', '222', '333'].map(id => enroll(root, id)));
  assert.deepEqual((await recipientState(root, creds)).chatIds.sort(), ['111', '222', '333']);
  await stopSubscriber({root, token: creds.token, chatId: '222'});
  assert.equal((await enroll(root, '222')).active, false);
  assert.deepEqual((await recipientState(root, creds)).chatIds.sort(), ['111', '333']);
  assert.deepEqual((await recipientState(root, {...creds, chatId: '222'})).chatIds.sort(), ['111', '333']);
  await enroll(root, '222', {reactivate: true});
  assert.equal((await recipientState(root, creds)).chatIds.length, 3);
  assert.deepEqual((await recipientState(root, {...creds, token: '999:OTHER'})).chatIds, []);
  await assert.rejects(enroll(root, '-100123'), /private chat/);
  const state = await readFile(path.join(root, 'data', 'telegram-subscribers.json'), 'utf8');
  assert.ok(!state.includes('TEST_SECRET'));
});

test('listener enrolls all private senders, routes replies correctly, skips duplicate/group/old commands and honors /stop', async t => {
  const root = await workspace(t), state = {offset: 0, lastQuickAt: 0}, handled = [], sent = [];
  let saves = 0;
  const args = {root, creds, state, now: () => now, save: async () => saves++, username: 'ourbot',
    handle: async ({creds: recipient}) => {handled.push(recipient.chatId); return {status: 'help'};},
    send: async (recipient, text) => {sent.push({id: recipient.chatId, text}); return 1;}};
  const update = (id, chatId, text, type = 'private', date = now / 1000) => ({update_id: id, message: {date, text, chat: {id: chatId, type}}});
  await handleIncomingUpdate({...args, update: update(1, 111, '/start')});
  await handleIncomingUpdate({...args, update: update(2, 222, 'hello')});
  assert.deepEqual(handled, ['111', '222']);
  assert.equal(sent[0].id, '222');
  assert.match(sent[0].text, /đăng ký/);
  await handleIncomingUpdate({...args, update: update(2, 222, '/price')});
  await handleIncomingUpdate({...args, update: update(3, -1001, '/start', 'group')});
  await handleIncomingUpdate({...args, update: update(4, 333, '/start@other')});
  await handleIncomingUpdate({...args, update: update(5, 444, '/price', 'private', now / 1000 - 3600)});
  assert.deepEqual(handled, ['111', '222']);
  assert.deepEqual((await recipientState(root, creds)).chatIds.sort(), ['111', '222', '444']);
  await handleIncomingUpdate({...args, update: update(6, 222, '/stop')});
  await handleIncomingUpdate({...args, update: update(7, 222, '/help')});
  assert.equal((await recipientState(root, creds)).chatIds.includes('222'), false);
  await handleIncomingUpdate({...args, update: update(8, 222, '/start')});
  assert.equal((await recipientState(root, creds)).chatIds.includes('222'), true);
  assert.equal(state.offset, 9);
  assert.equal(saves, 8);
});

test('each /price fetches fresh while each reply keeps its own destination', async t => {
  const root = await workspace(t), state = {offset: 0, lastQuickAt: 0}, replies = [];
  let runs = 0;
  for (const [id, chatId] of [[1, 111], [2, 222]]) {
    await handleIncomingUpdate({root, creds, state, now: () => now, save: async () => {},
      update: {update_id: id, message: {text: '/price', chat: {id: chatId, type: 'private'}}},
      handle: args => handleCommand({...args, busy: async () => false, sleep: async () => {}, quick: async () => {runs++; return 0;},
        context: async () => ({providers: [{...provider, history: [record(now)]}], query, settings}),
        send: async (recipient, text) => {replies.push({id: recipient.chatId, text}); return 1;}})});
  }
  assert.equal(runs, 2);
  assert.deepEqual(replies.map(r => r.id), ['111', '111', '222', '222']);
  assert.match(replies[2].text, /Đang kiểm tra giá mới/);
  assert.match(replies[3].text, /Giá vé bạn vừa hỏi đây/);
});

test('broadcast paces recipients and removes blocked users without stopping other deliveries', async t => {
  const root = await workspace(t);
  await enroll(root, '111'); await enroll(root, '222');
  const delivered = [], waits = [];
  const result = await broadcast({root, creds, now, sleep: async ms => waits.push(ms), deliver: async recipient => {
    delivered.push(recipient.chatId);
    if (recipient.chatId === '111') {const error = new Error('blocked'); error.apiCode = 403; throw error;}
    return {status: 'sent'};
  }});
  assert.deepEqual(delivered, ['111', '222']);
  assert.deepEqual(waits, [1100]);
  assert.equal(result.sent, 1);
  assert.deepEqual((await recipientState(root, creds)).chatIds, ['222']);
  assert.equal((await enroll(root, '111')).active, false);
});

test('429 pauses the whole broadcast across restart and does not send to later recipients', async t => {
  const root = await workspace(t);
  await enroll(root, '111'); await enroll(root, '222');
  let sends = 0;
  const first = await broadcast({root, creds, now, sleep, deliver: async () => {sends++; return {status: 'send_failed', rateLimited: true, retryAfterSeconds: 90};}});
  assert.equal(first.status, 'retry_wait'); assert.equal(sends, 1);
  const retry = await broadcast({root, creds, now: now + 30000, sleep, deliver: async () => {sends++; return {status: 'sent'};}});
  assert.equal(retry.status, 'retry_wait'); assert.equal(sends, 1);
  const done = await broadcast({root, creds, now: now + 90001, sleep, deliver: async () => {sends++; return {status: 'sent'};}});
  assert.equal(done.sent, 2); assert.equal(sends, 3);
});

test('broadcast lock prevents concurrent fan-out', async t => {
  const root = await workspace(t); await enroll(root, '111');
  let ready, release;
  const entered = new Promise(resolve => ready = resolve), pending = new Promise(resolve => release = resolve);
  const first = broadcast({root, creds, sleep, deliver: async () => {ready(); await pending; return {status: 'sent'};}});
  await entered;
  assert.equal((await broadcast({root, creds, sleep, deliver: async () => {throw new Error('duplicate');}})).status, 'busy');
  release(); await first;
  await assert.rejects(access(path.join(root, 'data', 'telegram-broadcast.lock')), {code: 'ENOENT'});
});

test('price alert broadcasts dedupe independently for every subscriber', async t => {
  const root = await workspace(t); await enroll(root, '111'); await enroll(root, '222');
  const before = record(now - 1500000), after = record(now, 4100000), destinations = [];
  const args = {root, creds, provider, settings, sleep, send: async recipient => {destinations.push(recipient.chatId); return destinations.length;}};
  await notifyRecord({...args, record: before, history: [], now: now - 1500000});
  const first = await notifyRecord({...args, record: after, history: [before], now});
  assert.equal(first.sent, 2); assert.deepEqual(destinations, ['111', '222']);
  await notifyRecord({...args, record: after, history: [before], now: now + 1000});
  assert.equal(destinations.length, 2);
});

test('daily broadcast resumes failed recipients without repeating acknowledged text for others', async t => {
  const root = await workspace(t); await enroll(root, '111'); await enroll(root, '222');
  const texts = []; let failed = false;
  const args = {root, creds, settings, query, providers: [{...provider, history: [record(now)]}], sleep,
    send: async recipient => {texts.push(recipient.chatId); if (recipient.chatId === '222' && !failed) {failed = true; throw new Error('network');} return texts.length;}};
  assert.equal((await sendDaily({...args, now})).status, 'send_failed');
  assert.deepEqual(texts, ['111', '222']);
  assert.equal((await sendDaily({...args, now: now + 300001})).status, 'sent');
  assert.deepEqual(texts, ['111', '222', '222']);
  assert.equal((await sendDaily({...args, now: now + 600000})).status, 'already_sent');
  assert.equal(texts.length, 3);
});

test('Telegram exposes numeric HTTP/API codes for broadcast decisions without revealing token or descriptions', async () => {
  await assert.rejects(telegramCall(creds.token, 'sendMessage', {}, async () => ({ok: false, status: 403,
    json: async () => ({ok: false, error_code: 403, description: 'TEST_SECRET'})})),
  error => error.apiCode === 403 && error.httpStatus === 403 && !error.message.includes('TEST_SECRET'));
});
