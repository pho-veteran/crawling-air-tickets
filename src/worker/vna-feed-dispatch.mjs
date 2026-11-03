// Optional recovery path: a repository-scoped Actions token lets the existing
// Worker refresh job start the runner without depending on GitHub's scheduler.
// Never use the local gh CLI OAuth token here.
export const DISPATCH_INTERVAL_MS=10*60000;
export const DISPATCH_KEY='vna-feed-dispatch';
const endpoint='https://api.github.com/repos/pho-veteran/crawling-air-tickets/actions/workflows/vna-agency-feed.yml/dispatches';
export async function requestFeedRefresh({store,env,record,fetchImpl=fetch}){
  if(!env.GITHUB_ACTIONS_TOKEN)return {state:'disabled'};
  const now=store.now(),observed=Date.parse(record?.observed_at);
  if(Number.isFinite(observed)&&observed<=now&&now-observed<4*60000)return {state:'fresh'};
  // One durable claim shared by cron, commands and duplicate Queue deliveries.
  // An ambiguous network failure keeps its claim to avoid a dispatch storm.
  const claim={requested_at:now,next_attempt_at:now+DISPATCH_INTERVAL_MS,state:'pending'};
  const changed=await store.statement(`INSERT INTO runtime_state(key,document_json) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json
    WHERE json_extract(runtime_state.document_json,'$.next_attempt_at')<=?`,DISPATCH_KEY,JSON.stringify(claim),now).run();
  if(!changed.meta.changes)return {state:'throttled'};
  let state='network_error',http=null;
  try{
    const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',
      headers:{authorization:'Bearer '+env.GITHUB_ACTIONS_TOKEN,accept:'application/vnd.github+json',
        'content-type':'application/json','user-agent':'air-ticket-price-tracker','x-github-api-version':'2026-03-10'},
      body:JSON.stringify({ref:'main',inputs:{dry_run:'false'}}),signal:AbortSignal.timeout(15000)});
    http=response.status;state=[200,204].includes(http)?'accepted':'rejected';
  }catch{/* Do not store errors or response bodies that could contain credentials. */}
  const result={...claim,state,http};
  await store.statement("UPDATE runtime_state SET document_json=? WHERE key=? AND json_extract(document_json,'$.requested_at')=?",JSON.stringify(result),DISPATCH_KEY,now).run();
  console.log(JSON.stringify({event:'agency_feed_dispatch',state,http}));
  return {state,http};
}
