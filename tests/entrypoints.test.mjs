import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, mkdir, readFile, writeFile, access, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {projectRoot, cliPath} from '../src/shared/paths.mjs';
import {quickRun} from '../src/telegram/commands.mjs';

const execute = promisify(execFile);
const offlineEnv = {
  ...process.env,
  TELEGRAM_ENABLED: 'false',
  DAILY_REPORT_TIME: '07:00',
  DAILY_REPORT_UTC_OFFSET: '+07:00',
};

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fare-entrypoint-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const file of ['src', 'scripts', 'templates', 'config.json']) {
    await cp(path.join(projectRoot, file), path.join(root, file), {recursive: true});
  }
  const cwd = path.join(root, 'outside');
  await mkdir(cwd);
  const run = (file, args = []) => execute(process.execPath, [path.join(root, file), ...args], {
    cwd,
    env: offlineEnv,
    timeout: 15000,
    windowsHide: true,
  });
  return {root, cwd, run};
}

test('report, daily preview and smoke use the project storage root from another cwd', async t => {
  const {root, cwd, run} = await workspace(t);
  const {stdout} = await run('src/cli/run.mjs', ['--render-only']);
  const report = JSON.parse(stdout);
  assert.equal(report.html, path.join(root, 'report', 'index.html'));
  assert.equal(report.requests, 0);
  assert.deepEqual(report.airlines.map(p => p.status), ['no_history', 'no_history']);
  assert.match(await readFile(report.html, 'utf8'), /<!doctype html>/i);
  await assert.rejects(access(path.join(root, 'data', 'run.lock')), {code: 'ENOENT'});

  const preview = JSON.parse((await run('src/cli/daily.mjs', ['--preview'])).stdout);
  assert.equal(preview.status, 'preview_only');
  assert.equal(preview.file, path.join(root, 'data', 'daily-preview.txt'));
  assert.match(await readFile(preview.file, 'utf8'), /SGN/);

  await run('scripts/smoke.mjs');
  const smoke = JSON.parse(await readFile(path.join(root, 'data', 'smoke-result.json'), 'utf8'));
  assert.equal(smoke.status, 'passed');
  assert.equal(smoke.mode, 'preview_only');
  assert.ok(smoke.cases.every(c => c.messageIds.length === 0));
  assert.ok(smoke.cases.length > 0);
  await assert.rejects(access(path.join(cwd, 'data')), {code: 'ENOENT'});
  await assert.rejects(access(path.join(cwd, 'report')), {code: 'ENOENT'});
});

test('Telegram quickRun launches the relocated CLI and respects the existing crawl lock', async t => {
  const {root} = await workspace(t);
  await mkdir(path.join(root, 'data'));
  const lock = path.join(root, 'data', 'run.lock');
  await writeFile(lock, 'existing crawl');
  assert.equal(await quickRun(root), 3);
  assert.equal(await readFile(lock, 'utf8'), 'existing crawl');
  await assert.rejects(access(path.join(root, 'data', 'history.jsonl')), {code: 'ENOENT'});
});

test('watch launches its relocated child with the shared root and releases its lock on stop', async t => {
  const {root, run} = await workspace(t);
  const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  config.monitoring.dailyReport = false;
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  // Replace the crawler only in this isolated copy; exercise orchestration without network access.
  await writeFile(cliPath('run.mjs', root), `
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from '../shared/paths.mjs';
await writeFile(path.join(projectRoot, 'data', 'child.json'), JSON.stringify({
  cwd: process.cwd(), managed: process.env.TRACKER_MANAGED
}));
await writeFile(path.join(projectRoot, 'data', 'watch.stop'), 'stop');
`);
  await run('src/cli/watch.mjs');
  const child = JSON.parse(await readFile(path.join(root, 'data', 'child.json'), 'utf8'));
  assert.deepEqual(child, {cwd: root, managed: '1'});
  await assert.rejects(access(path.join(root, 'data', 'watch.lock')), {code: 'ENOENT'});
});
