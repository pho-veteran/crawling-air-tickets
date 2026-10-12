import {loadEnv} from '../src/telegram/client.mjs';
import {readFile,writeFile,unlink,mkdir,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {projectRoot} from '../src/shared/paths.mjs';
import {queryFrom,SOURCE} from '../src/providers/vna.mjs';
import {SOURCE as VJ} from '../src/providers/vietjet.mjs';
import {settingsFrom} from '../src/monitoring/alerts.mjs';
import {readHistory} from '../src/reporting/history.mjs';
import {credentials,telegramCall} from '../src/telegram/client.mjs';
const root=projectRoot;
loadEnv(root);
try{
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('Cần Node.js 24+.');
  const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8')),query=queryFrom(config);settingsFrom(config.monitoring);
  async function findModules(folder){
    const files=[];
    for(const entry of await readdir(path.join(root,folder),{withFileTypes:true})){
      const file=path.join(folder,entry.name);
      if(entry.isDirectory())files.push(...await findModules(file));
      else if(entry.name.endsWith('.mjs'))files.push(file);
    }
    return files;
  }
  const modules=[...await findModules('src'),...await findModules('scripts'),...await findModules('tests')];
  for(const file of modules){const result=spawnSync(process.execPath,['--check',path.join(root,file)],{stdio:'pipe',windowsHide:true});if(result.status!==0)throw new Error('Lỗi cú pháp: '+file);}
  for(const folder of ['data']){const dir=path.join(root,folder);await mkdir(dir,{recursive:true});const probe=path.join(dir,'.preflight-'+randomUUID());await writeFile(probe,'ok',{flag:'wx'});await unlink(probe);}
  for(const source of [SOURCE,VJ]){const history=await readHistory(path.join(root,'data','history.jsonl'),query,source);console.log('Lịch sử '+source+': '+history.length+' dòng hợp lệ.');}
  const tests=spawnSync(process.execPath,['--test','tests/*.test.mjs'],{cwd:root,stdio:'inherit',windowsHide:true});if(tests.status!==0)throw new Error('Regression test chưa đạt.');
  const creds=credentials(root);if(!creds.enabled||!creds.configured)throw new Error('Telegram chưa đủ cấu hình/bật.');
  const me=await telegramCall(creds.token,'getMe');if(!me.is_bot)throw new Error('Token không xác nhận tài khoản bot.');
  console.log('PREFLIGHT PASS: cấu hình, cú pháp, quyền ghi, lịch sử, tests và Telegram getMe. Chưa crawl/gửi tin/chạy nền.');
}catch(e){console.error(e.message);process.exitCode=1;}
