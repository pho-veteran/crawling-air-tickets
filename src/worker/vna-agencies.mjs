import {crawl as directCrawl,SOURCE} from '../providers/vna-agencies.mjs';
import {queryId} from '../providers/vna-core.mjs';
import {canonicalJson} from '../storage/d1.mjs';
import {requestFeedRefresh} from './vna-feed-dispatch.mjs';
export {SOURCE};
export const FEED_MAX_AGE_MS=15*60000;
export const feedKey=query=>'vna-agency-feed:'+queryId(query,SOURCE);
export async function crawl(query,{fetchImpl=fetch,store,env={}}={}){
  if(env.VNA_FEED!=='1')return directCrawl(query,{fetchImpl});
  const record=await store.state(feedKey(query),null);
  const dispatch=await requestFeedRefresh({store,env,record,fetchImpl}),requests=dispatch.http===undefined?0:1;
  if(!record||canonicalJson(record.query)!==canonicalJson(query)||store.now()-Date.parse(record.observed_at)>FEED_MAX_AGE_MS)
    throw Object.assign(new Error('VNA agency feed is missing or older than 15 minutes; retaining last good estimate'),{requests,sourceCode:'VNA_FEED_STALE'});
  return {...record,requests,duration_ms:0,transport:'github-actions-feed'};
}
