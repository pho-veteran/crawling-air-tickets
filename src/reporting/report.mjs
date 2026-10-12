import {createReadStream} from 'node:fs';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {queryId,SOURCE} from '../providers/vna.mjs';

export async function readHistory(file,query,source=SOURCE) {
  const records=[];
  const input=createReadStream(file,{encoding:'utf8'});
  const lines=createInterface({input,crlfDelay:Infinity});
  let number=0;
  try {
    for await(const line of lines) {
      number++;if(!line.trim())continue;
      let record;try{record=JSON.parse(line);}catch{throw new Error(`Lịch sử hỏng ở dòng ${number}; chưa sửa/xóa dữ liệu.`);}
      if(record.schema===1 && record.source===source && record.query_id===queryId(query,source)) records.push(record);
    }
  } catch(e) {if(e.code!=='ENOENT')throw e;}
  return records.sort((a,b)=>a.observed_at.localeCompare(b.observed_at));
}
export async function writeReport({file,providers,query,template,batch=null}) {
  const html=await readFile(template,'utf8');
  const data=JSON.stringify({generated_at:new Date().toISOString(),query,providers,batch})
    .replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  if(!html.includes('/*__REPORT_DATA__*/null'))throw new Error('Template thiếu vị trí dữ liệu.');
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file+'.tmp',html.replace('/*__REPORT_DATA__*/null',()=>data),'utf8');
  await rename(file+'.tmp',file);
}
