import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
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
