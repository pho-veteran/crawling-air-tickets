import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {queryFrom,SOURCE} from './api.mjs';
import {SOURCE as VJ} from './vietjet.mjs';
import {readHistory,writeReport} from './report.mjs';
import {settingsFrom} from './alerts.mjs';
export async function loadContext(root){
  const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
  const query=queryFrom(config),settings=settingsFrom(config.monitoring);
  const providers=[{id:'vna',name:'Vietnam Airlines',source:SOURCE,basis:'Khứ hồi gồm thuế theo nguồn. Giá từng chiều là vé mua riêng, không nhất thiết cộng bằng giá khứ hồi.'},{id:'vietjet',name:'Vietjet',source:VJ,basis:'Lịch giá tham khảo trong 24 giờ qua. Chưa xác định thuế/phí, không gồm hành lý ký gửi.'}];
  for(const p of providers)p.history=await readHistory(path.join(root,'data','history.jsonl'),query,p.source);
  return {providers,query,settings};
}
export async function makeReport(root,context,file=path.join(root,'report','telegram.html')){
  await writeReport({file,...context,template:path.join(root,'templates','report.html')});return file;
}
