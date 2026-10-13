import {readFile} from 'node:fs/promises';
import {cloudflare,RemoteD1} from './lib/worker-api.mjs';
const db=new RemoteD1('aa8be7a3-77e5-4de3-a124-d28b2a056f9d');
const sql=await readFile(new URL('../migrations/0003_interactive.sql',import.meta.url),'utf8');
for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
const queues=await cloudflare('/queues');
if(!queues.some(q=>q.queue_name==='crawling-air-tickets-delivery'))await cloudflare('/queues',{method:'POST',body:{queue_name:'crawling-air-tickets-delivery'}});
console.log(JSON.stringify({migration:'0003_interactive',delivery_queue:'crawling-air-tickets-delivery',ready:true}));
