import config from '../config.json' with {type:'json'};
import {queryFrom} from '../src/providers/vna-core.mjs';
import {crawl} from '../src/providers/vna-agencies.mjs';
const record=await crawl(queryFrom(config));
console.log(JSON.stringify({event:'agency_crawl_complete',status:record.status,requests:record.requests,duration_ms:record.duration_ms,
  agencies:record.agency_quotes.map(q=>({agency:q.agency,leg:q.leg,status:q.status}))}));
const crawlFailed=record.agency_quotes.some(q=>q.status==='error');
if(process.argv.includes('--dry-run'))process.exit(crawlFailed?1:0);
if(!process.env.VNA_FEED_SECRET)throw new Error('VNA_FEED_SECRET is required');
const url='https://crawling-air-tickets.thanhvinhlqt2016.workers.dev/sources/vna';
const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-vna-feed-secret':process.env.VNA_FEED_SECRET},body:JSON.stringify(record),redirect:'error',signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error('Agency feed delivery HTTP '+r.status);
console.log(JSON.stringify({event:'agency_feed_delivered',http:r.status}));
// Completed searches without bookable fares are valid results. Still deliver
// partial results, but fail the run if any agency could not complete its crawl.
if(crawlFailed)process.exitCode=1;
