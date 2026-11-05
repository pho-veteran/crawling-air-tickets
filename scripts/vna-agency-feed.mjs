import config from '../config.json' with {type:'json'};
import {queryFrom} from '../src/providers/vna-core.mjs';
import {crawl} from '../src/providers/vna-agencies.mjs';
const record=await crawl(queryFrom(config));
console.log(JSON.stringify({event:'agency_crawl_complete',status:record.status,requests:record.requests,duration_ms:record.duration_ms,
  agencies:record.agency_quotes.map(q=>({agency:q.agency,leg:q.leg,status:q.status,...(q.status==='error'?{error:q.error}:{})}))}));
const failed=record.agency_quotes.filter(q=>q.status==='error');
if(failed.length){
  const message='Incomplete crawl for '+failed.map(q=>q.agency+' ('+q.leg+')').join(', ')+'; using completed agency results';
  console.warn(process.env.GITHUB_ACTIONS==='true'?'::warning title=Partial agency crawl::'+message:message);
}
// crawl() throws if no agency completes. A failed optional source does not
// invalidate the completed results; status stays partial for the Worker/bot.
if(process.argv.includes('--dry-run'))process.exit(0);
if(!process.env.VNA_FEED_SECRET)throw new Error('VNA_FEED_SECRET is required');
const url='https://crawling-air-tickets.thanhvinhlqt2016.workers.dev/sources/vna';
const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-vna-feed-secret':process.env.VNA_FEED_SECRET},body:JSON.stringify(record),redirect:'error',signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error('Agency feed delivery HTTP '+r.status);
console.log(JSON.stringify({event:'agency_feed_delivered',http:r.status}));
