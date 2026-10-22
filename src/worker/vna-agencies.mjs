import {crawl as directCrawl,SOURCE} from '../providers/vna-agencies.mjs';
import {queryId} from '../providers/vna-core.mjs';
import {canonicalJson} from '../storage/d1.mjs';
export {SOURCE};
export const FEED_MAX_AGE_MS=15*60000;
export const feedKey=query=>'vna-agency-feed:'+queryId(query,SOURCE);
export async function crawl(query,{fetchImpl=fetch,store,env={}}={}){
  if(env.VNA_FEED!=='1')return directCrawl(query,{fetchImpl});
  const record=await store.state(feedKey(query),null);
  if(!record||canonicalJson(record.query)!==canonicalJson(query)||store.now()-Date.parse(record.observed_at)>FEED_MAX_AGE_MS)
    throw new Error('VNA agency feed is missing or older than 15 minutes; retaining last good estimate');
  return {...record,requests:0,duration_ms:0,transport:'github-actions-feed'};
}
