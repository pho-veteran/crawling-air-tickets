import {writeFileSync} from 'node:fs';
import {loadEnv,credentials} from '../telegram/client.mjs';
import {readFile,mkdir,open,unlink,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {projectRoot,cliPath} from '../shared/paths.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {settingsFrom} from '../monitoring/alerts.mjs';
import {nextMorning,morningAt} from '../monitoring/messages.mjs';
const root=projectRoot;
loadEnv(root);
const settings=settingsFrom(JSON.parse(await readFile(path.join(root,'config.json'),'utf8')).monitoring);
const lockFile=path.join(root,'data','watch.lock');
await mkdir(path.dirname(lockFile),{recursive:true});
let lock;
try{lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));}
catch(e){if(e.code==='EEXIST'){console.error('watch.lock đang tồn tại. Kiểm tra PID trước khi xóa lock.');process.exit(3);}throw e;}
const stopFile=path.join(root,'data','watch.stop');
try{await unlink(stopFile);}catch(e){if(e.code!=='ENOENT')throw e;}
const controller=new AbortController();let stopping=false;const children=new Set();
const stop=()=>{stopping=true;writeFileSync(stopFile,'stop');controller.abort();for(const child of children)if(process.platform!=='win32')child.kill('SIGTERM');};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
console.log('Theo dõi mỗi '+settings.pollMinutes+' phút; bản tin chung '+settings.dailyTime+' UTC'+settings.dailyUtcOffset+': '+settings.dailyReport+'. Ctrl+C để dừng.');
const run=file=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cliPath(file,root)],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,TRACKER_MANAGED:'1'}});
  children.add(child);child.once('error',e=>{children.delete(child);reject(e);});child.once('exit',code=>{children.delete(child);resolve(code);});
});
async function wait(ms){const end=Date.now()+ms;while(!stopping&&Date.now()<end){try{await access(stopFile);stop();break;}catch(e){if(e.code!=='ENOENT')throw e;}try{await delay(Math.max(1,Math.min(1000,end-Date.now())),null,{signal:controller.signal});}catch(e){if(e.name!=='AbortError')throw e;}}}
async function poll(){
  while(!stopping){
    const began=Date.now(),code=await run('run.mjs');
    if(code)console.error('Crawl kết thúc với mã '+code+'; xem trạng thái từng hãng.');
    if(stopping)break;
    const next=began+settings.pollMinutes*60000;console.log('Crawl tiếp: '+new Date(next).toISOString());await wait(Math.max(1000,next-Date.now()));
  }
}
async function daily(){
  if(!settings.dailyReport)return;
  while(!stopping){
    const next=nextMorning(Date.now(),settings);console.log('Bản tin chung tiếp: '+new Date(next).toISOString()+' ('+settings.dailyTime+' UTC'+settings.dailyUtcOffset+')');
    await wait(next-Date.now());if(stopping)break;
    // After a suspended machine resumes, send only today's due report, never a backlog.
    if(Date.now()<morningAt(Date.now(),settings))continue;
    let code;
    do{code=await run('daily.mjs');if(code&&!stopping)await wait(5*60000);}while(code&&!stopping&&Date.now()>=morningAt(Date.now(),settings)&&morningAt(Date.now(),settings)===morningAt(next,settings));
  }
}
async function bot(){if(!credentials(root).configured||!credentials(root).enabled)return;while(!stopping){await run('bot.mjs');if(!stopping)await wait(60000);}}
try{await Promise.all([poll(),daily(),bot()]);}
finally{stopping=true;controller.abort();await lock.close();await unlink(lockFile);}
