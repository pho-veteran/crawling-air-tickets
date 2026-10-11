import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Public requests, sequentially paced; no retries or challenge handling.
export async function createBatch({root,seconds=90,requestCount=5,quick=false,fetchImpl=fetch,now=Date.now,sleep=delay}) {
  if(!Number.isFinite(seconds)||(quick?(seconds<1||seconds>9):(seconds<90||seconds>300)))throw new Error('Batch thường 90–300s; quick 1–9s.');
  if(!Number.isInteger(requestCount)||requestCount<1||requestCount>5)throw new Error('requestCount phải từ 1 đến 5.');
  const started=now(),deadline=started+seconds*1000,gap=quick?0:seconds*1000/requestCount;
  const file=path.join(root,'data','http-cooldowns.json');let cooldowns={},lastStart=null,requests=0;
  try{cooldowns=JSON.parse(await readFile(file,'utf8'));if(!cooldowns||Array.isArray(cooldowns)||typeof cooldowns!=='object')throw new Error();}
  catch(e){if(e.code!=='ENOENT')throw new Error('http-cooldowns.json không hợp lệ; kiểm tra trước khi gọi nguồn.');}
  async function pacedFetch(url,options={}) {
    const origin=new URL(url).origin;
    const until=Number(cooldowns[origin])||0;
    if(now()<until)throw new Error('Nguồn đang nghỉ đến '+new Date(until).toISOString()+' sau giới hạn HTTP; không gửi request.');
    const wait=lastStart===null?0:Math.max(0,lastStart+gap-now());
    if(now()+wait>=deadline)throw new Error('Hết ngân sách thời gian batch; không gửi thêm request.');
    if(wait)await sleep(wait);
    const remaining=deadline-now();
    if(remaining<=0)throw new Error('Hết ngân sách thời gian batch.');
    lastStart=now();requests++;
    // Start the network timeout after pacing, not while waiting for the next slot.
    const signal=AbortSignal.timeout(Math.max(1,Math.floor(Math.min(30000,remaining))));
    const response=await fetchImpl(url,{...options,signal});
    if([403,429,503].includes(response.status)) {
      const retry=response.headers.get('retry-after');
      const serverUntil=retry===null?0:/^\d+$/.test(retry.trim())?now()+Number(retry)*1000:Date.parse(retry);
      const fallback=response.status===403?6*3600000:3600000;
      cooldowns[origin]=Math.max(now()+fallback,Number.isFinite(serverUntil)?serverUntil:0);
      await mkdir(path.dirname(file),{recursive:true});
      await writeFile(file+'.tmp',JSON.stringify(cooldowns,null,2));await rename(file+'.tmp',file);
    }
    return response;
  }
  return {fetch:pacedFetch,get requests(){return requests;},
    async finish(){if(!quick&&requests&&now()<deadline)await sleep(deadline-now());return {duration_ms:now()-started,requests,budget_seconds:seconds};}};
}
