import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {queryFrom,SOURCE} from '../providers/vna.mjs';
import {SOURCE as VJ,BASIS} from '../providers/vietjet.mjs';
import {readHistory} from './history.mjs';
import {settingsFrom} from '../monitoring/alerts.mjs';
export async function loadContext(root){
  const config=JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
  const query=queryFrom(config),settings=settingsFrom(config.monitoring);
  const providers=[{id:'vna',name:'Vietnam Airlines',source:SOURCE,basis:'Khứ hồi gồm thuế theo nguồn. Giá từng chiều là vé mua riêng, không nhất thiết cộng bằng giá khứ hồi.'},{id:'vietjet',name:'Vietjet',source:VJ,basis:BASIS}];
  for(const p of providers)p.history=await readHistory(path.join(root,'data','history.jsonl'),query,p.source);
  return {providers,query,settings};
}
