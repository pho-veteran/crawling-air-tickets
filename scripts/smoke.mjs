import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from '../src/shared/paths.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {smokeCases} from './fixtures/smoke-cases.mjs';
import {credentials,sendTelegram} from '../src/telegram/client.mjs';
import {privateChatId} from '../src/telegram/subscribers.mjs';
const root=projectRoot;
const {values}=parseArgs({options:{send:{type:'boolean',default:false},'chat-id':{type:'string'}}});
const dir=path.join(root,'data');await mkdir(dir,{recursive:true});
const cases=smokeCases(),base=values.send?credentials(root):null,creds=base?{...base,chatId:values['chat-id']||base.chatId}:null,report={created_at:new Date().toISOString(),mode:values.send?'live_telegram_simulated_prices':'preview_only',cases:[]};
if(values.send&&!privateChatId(creds.chatId))throw new Error('Smoke cần --chat-id <private chat ID> để gửi riêng cho người kiểm tra.');
await writeFile(path.join(dir,'smoke-preview.txt'),cases.map(c=>c.text).join('\n\n════════════════\n\n'));
try{
  for(const c of cases){
    const result={name:c.name,keys:c.keys,messageIds:[],boldEntities:0};
    if(values.send){
      await sendTelegram(creds,c.text,async(url,options)=>{
        const response=await fetch(url,options);const data=await response.clone().json();
        if(data.ok){result.messageIds.push(data.result.message_id);result.boldEntities+=(data.result.entities||[]).filter(e=>e.type==='bold').length;}
        return response;
      });
      if(!result.boldEntities)throw new Error('Telegram chưa xác nhận chữ đậm của mẫu '+c.name);
      await delay(1200);
    }
    report.cases.push(result);console.log((values.send?'Đã gửi: ':'Đã dựng: ')+c.name);
  }
  report.status='passed';
}catch(e){report.status='failed';report.error=/^TELEGRAM_[A-Z_0-9]+/.exec(String(e.message))?.[0]||'SMOKE_FAILED';process.exitCode=1;console.error(report.error);}
await writeFile(path.join(dir,'smoke-result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,cases:report.cases.length,messages:report.cases.reduce((sum,c)=>sum+c.messageIds.length,0),report:path.join(dir,'smoke-result.json')}));
