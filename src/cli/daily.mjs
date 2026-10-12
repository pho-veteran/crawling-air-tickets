import {loadEnv} from '../telegram/client.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from '../shared/paths.mjs';
import {parseArgs} from 'node:util';
import {queryFrom,SOURCE} from '../providers/vna.mjs';
import {SOURCE as VIETJET_SOURCE} from '../providers/vietjet.mjs';
import {readHistory} from '../reporting/report.mjs';
import {settingsFrom} from '../monitoring/alerts.mjs';
import {formatDaily} from '../monitoring/messages.mjs';
import {sendDaily} from '../monitoring/daily.mjs';
const root=projectRoot;
loadEnv(root);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{});
try{
  const {values}=parseArgs({options:{preview:{type:'boolean',default:false}}});
  const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8')),query=queryFrom(config),settings=settingsFrom(config.monitoring);
  const providers=[{id:'vna',name:'Vietnam Airlines',source:SOURCE},{id:'vietjet',name:'Vietjet',source:VIETJET_SOURCE}];
  for(const p of providers)p.history=await readHistory(path.join(root,'data','history.jsonl'),query,p.source);
  if(values.preview){const file=path.join(root,'data','daily-preview.txt');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,formatDaily({providers,query,pollMinutes:settings.pollMinutes,settings}));console.log(JSON.stringify({status:'preview_only',file}));}
  else{const result=await sendDaily({root,providers,query,settings});console.log(JSON.stringify(result));if(['send_failed','retry_wait'].includes(result.status))process.exitCode=4;else if(result.status==='busy')process.exitCode=3;}
}catch{console.error('Bản tin sáng chưa hoàn tất; kiểm tra config/history/daily-state và quyền ghi data.');process.exitCode=1;}
