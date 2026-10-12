import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, mkdir, readFile, writeFile, access, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
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
  for (const file of ['src', 'scripts', 'config.json']) {
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

test('daily preview and smoke use the project storage root from another cwd', async t => {
  const {root, cwd, run} = await workspace(t);
  await assert.rejects(run('src/cli/run.mjs', ['--render-only']), /Unknown option/);
  await assert.rejects(access(path.join(root, 'report')), {code: 'ENOENT'});

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

test('CLI counts failed requests and persists diagnostics even when all fetches reject', async t => {
  const {root,cwd}=await workspace(t),fixture=path.join(root,'fail-fetch.mjs');
  await writeFile(fixture,"globalThis.fetch=async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('connection reset'),{code:'ECONNRESET'})});};");
  let output;
  try{await execute(process.execPath,['--import',pathToFileURL(fixture).href,cliPath('run.mjs',root),'--airline','vna','--no-notify'],{cwd,env:offlineEnv,windowsHide:true});}
  catch(e){assert.equal(e.code,1);output=JSON.parse(e.stdout);}
  assert.ok(output);assert.equal(output.requests,1);assert.equal(output.batch.requests,1);
  const record=JSON.parse((await readFile(path.join(root,'data','history.jsonl'),'utf8')).trim());
  assert.equal(record.requests,1);assert.equal(record.request_diagnostics.length,1);
  assert.ok(record.request_diagnostics.every(r=>r.errors[1].code==='ECONNRESET'));
  const logFile='crawl-'+record.observed_at.slice(0,10)+'.jsonl';
  const rows=(await readFile(path.join(root,'data',logFile),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(r=>r.event==='request_failed').length,1);
  assert.equal(rows.at(-1).event,'crawl_complete');assert.equal(rows.at(-1).exit_code,1);
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
  const {stdout} = await run('src/cli/watch.mjs');
  assert.match(stdout, /Theo dõi mỗi 10 phút/);
  const child = JSON.parse(await readFile(path.join(root, 'data', 'child.json'), 'utf8'));
  assert.deepEqual(child, {cwd: root, managed: '1'});
  await assert.rejects(access(path.join(root, 'data', 'watch.lock')), {code: 'ENOENT'});
});
