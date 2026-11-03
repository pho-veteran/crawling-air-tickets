import {readFile} from 'node:fs/promises';
import path from 'node:path';
export const accountId='c0caa75e344cbfbb5ad55cfc712bbc30';
export const workerUrl='https://crawling-air-tickets.thanhvinhlqt2016.workers.dev';
export async function cloudflare(route,{method='GET',body}={}){
  const token=process.env.CLOUDFLARE_API_TOKEN||JSON.parse(await readFile(path.join(process.env.APPDATA,'xdg.config/cloudflare/config/default.json'),'utf8')).oauth_token;
  const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+accountId+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  const p=await r.json();if(!r.ok||!p.success)throw new Error('Cloudflare API HTTP '+r.status+' code '+(p.errors?.[0]?.code||'unknown'));
  return p.result;
}
export const secrets=async()=>JSON.parse(await readFile('.env.worker.json','utf8'));
export async function worker(route,{method='GET',body}={}){
  const s=await secrets();const r=await fetch(workerUrl+route,{method,headers:{authorization:'Bearer '+s.ADMIN_SECRET,'content-type':'application/json'},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  const p=await r.json();if(!r.ok)throw new Error('Worker HTTP '+r.status);return p;
}
export class RemoteD1 {
  constructor(id){this.id=id;this.totals={requests:0,statements:0,rows_read:0,rows_written:0};}
  prepare(sql){
    const db=this,make=values=>({sql,values,bind(...bound){return make(bound);},
      async all(){return (await db.batch([this]))[0];},async run(){return this.all();},
      async first(column){const row=(await this.all()).results?.[0];return column?(row?.[column]??null):(row??null);},
    });return make([]);
  }
  async batch(statements){
    const results=await cloudflare('/d1/database/'+this.id+'/query',{method:'POST',body:{batch:statements.map(s=>({sql:s.sql,params:s.values}))}});
    if(results.length!==statements.length||results.some(r=>!r.success))throw new Error('D1 batch rejected; inspect safe error codes.');
    this.totals.requests++;this.totals.statements+=statements.length;
    for(const r of results){this.totals.rows_read+=r.meta?.rows_read||0;this.totals.rows_written+=r.meta?.rows_written||0;}
    return results;
  }
}
