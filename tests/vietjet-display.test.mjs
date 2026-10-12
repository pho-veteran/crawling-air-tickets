import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, cp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {crawl, SOURCE} from '../src/providers/vietjet.mjs';
import {queryFrom} from '../src/providers/vna.mjs';
import {formatDaily} from '../src/monitoring/messages.mjs';
import {evaluateAlerts, alertGroups, formatAlert, settingsFrom} from '../src/monitoring/alerts.mjs';
import {sendDaily} from '../src/monitoring/daily.mjs';
import {handleCommand} from '../src/telegram/commands.mjs';
import {projectRoot} from '../src/shared/paths.mjs';
import {simulatedCalendar} from '../scripts/fixtures/vietjet-calendar.mjs';

const config = {origin: 'SGN', destination: 'VCL', departureDate: '2027-02-04', returnDate: '2027-02-13', adults: 1};
const query = queryFrom(config);
const provider = {id: 'vietjet', name: 'Vietjet', source: SOURCE};
const settings = settingsFrom({}, {});
const now = Date.parse('2026-10-12T07:00:00+07:00');
const creds = {token: '123:TEST', chatId: '456', enabled: true, configured: true};

async function snapshot(options = {}, observedAt = '2026-10-12T06:50:00+07:00') {
  const source = simulatedCalendar(query, options);
  const record = await crawl(query, {fetchImpl: source.fetch});
  assert.equal(source.requests.length, 2);
  record.observed_at = observedAt;
  for (const leg of Object.values(record.legs)) for (const quote of leg) quote.observed_at = observedAt;
  return record;
}

function assertLegLines(text, out = '1.800.000đ', back = '2.400.000đ') {
  const section = text.split('🟥 VIETJET')[1];
  assert.ok(section, 'Vietjet section is present');
  assert.ok(section.includes('🛫 Vé đi SGN → VCL · 04/02/2027: ' + out));
  assert.ok(section.includes('🛬 Vé về VCL → SGN · 13/02/2027: ' + back));
}

function reportData(html) {
  return JSON.parse(html.match(/const DATA=(.*);/)[1]);
}

test('Vietjet calendars preserve independent main-date prices and their roundtrip sum', async () => {
  const record = await snapshot();
  assert.equal(record.status, 'ok');
  assert.equal(record.main_price, 4200000);
  assert.equal(record.legs.outbound.find(x => x.date === query.departureDate).price, 1800000);
  assert.equal(record.legs.inbound.find(x => x.date === query.returnDate).price, 2400000);
  assert.equal(record.cells.length, 49);
  assertLegLines(formatDaily({providers: [{...provider, history: [record]}], query, now}));
});

for (const failLeg of ['outbound', 'inbound']) {
  test(`Vietjet keeps the other direction when ${failLeg} fails, without inventing a total`, async () => {
    const record = await snapshot({failLeg});
    assert.equal(record.status, 'partial');
    assert.equal(record.main_price, null);
    assert.equal(record.minimum_price, null);
    assert.ok(record.cells.every(c => c.price === null));
    assert.ok(record.legs[failLeg].every(q => q.price === null));
    assert.match(record.leg_errors[failLeg], /503/);
    const text = formatDaily({providers: [{...provider, history: [record]}], query, now});
    assertLegLines(text, failLeg === 'outbound' ? 'chưa có giá' : '1.800.000đ', failLeg === 'inbound' ? 'chưa có giá' : '2.400.000đ');
    assert.match(text, /Cộng vé đi và về hiện là chưa có giá/);
    assert.ok(text.includes('Chưa cập nhật được giá chiều ' + (failLeg === 'outbound' ? 'đi' : 'về')));
    assert.doesNotMatch(text, /(?:^|\s)0đ/);
  });
}

test('Vietjet reports an error when neither direction can be fetched', async () => {
  const source = simulatedCalendar(query, {failLeg: 'both'});
  await assert.rejects(crawl(query, {fetchImpl: source.fetch}), error => error.requests === 2 && /outbound.*inbound/.test(error.message));
  assert.equal(source.requests.length, 2);
});

test('older Vietjet history without leg quotes never derives each direction by splitting the total', async () => {
  const record = await snapshot();
  delete record.legs;
  const text = formatDaily({providers: [{...provider, history: [record]}], query, now});
  assertLegLines(text, 'chưa có giá', 'chưa có giá');
  assert.match(text, /Cộng vé đi và về hiện là 4.200.000đ/);
  assert.doesNotMatch(text, /2.100.000đ/);
});

test('Vietjet outbound and inbound alerts show their own prices and routes when total is unchanged', async () => {
  const before = await snapshot({}, '2026-10-11T22:50:00+07:00');
  for (const [outbound, inbound, leg, route, price] of [[1700000, 2500000, 'outbound', 'SGN → VCL', '1.700.000đ'], [1900000, 2300000, 'inbound', 'VCL → SGN', '2.300.000đ']]) {
    const record = await snapshot({outbound, inbound});
    assert.equal(record.main_price, before.main_price);
    const groups = alertGroups(evaluateAlerts(provider, record, [before], {initialized: true}, settings));
    assert.equal(groups.length, 1);
    assert.equal(groups[0][0].guard.leg, leg);
    const text = formatAlert(provider, record, groups[0], [before]);
    assert.ok(text.includes(route));
    assert.ok(text.includes(price));
    assert.match(text, /giảm 100.000đ/);
    assert.match(text, /24h; chưa xác định thuế/);
  }
});

test('daily, /price and /report send Vietjet leg data in text and the actual HTML attachment', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fare-vietjet-display-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'data'));
  await cp(path.join(projectRoot, 'templates'), path.join(root, 'templates'), {recursive: true});
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  const before = await snapshot({outbound: 1900000, inbound: 2300000}, '2026-10-11T22:50:00+07:00');
  const record = await snapshot();
  await writeFile(path.join(root, 'data', 'history.jsonl'), [before, record].map(r => JSON.stringify(r)).join('\n') + '\n');
  const texts = [], attachments = [];
  const send = async (_, text) => {texts.push(text); return texts.length;};
  const attach = async (_, file) => {
    const html = await readFile(file, 'utf8');
    const data = reportData(html), last = data.providers.find(p => p.id === 'vietjet').history.at(-1);
    assert.equal(last.legs.outbound.find(x => x.date === query.departureDate).price, 1800000);
    assert.equal(last.legs.inbound.find(x => x.date === query.returnDate).price, 2400000);
    attachments.push(html);
    return attachments.length;
  };
  const daily = await sendDaily({root, providers: [{...provider, history: [before, record]}], query, settings, now, creds, send, attach});
  assert.equal(daily.status, 'sent');
  assertLegLines(texts[0]);
  assert.match(texts[0], /↓ 100.000đ/);
  assert.match(texts[0], /↑ 100.000đ/);

  for (const command of ['/price', '/report']) {
    await handleCommand({root, creds, state: {}, now: () => now, busy: async () => false, sleep: async () => {}, quick: async () => 0, send, attach,
      update: {message: {text: command, chat: {type: 'private', id: creds.chatId}}}});
  }
  assert.match(texts[1], /Đang kiểm tra giá mới/);
  assertLegLines(texts[2]);
  assert.equal(texts.length, 3);
  assert.equal(attachments.length, 3);
});
