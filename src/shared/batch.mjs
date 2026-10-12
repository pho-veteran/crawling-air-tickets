// Retrieval fires all requests concurrently with no client-side pacing,
// time budget, or cooldowns. Extra options are accepted and ignored so
// existing callers keep working. Per-request timeouts come from the callers.
export async function createBatch({fetchImpl=fetch}={}) {
  const started=Date.now();let requests=0;
  async function fetch(url,options={}){requests++;return fetchImpl(url,options);}
  return {fetch,get requests(){return requests;},
    async finish(){return {duration_ms:Date.now()-started,requests,budget_seconds:null};}};
}
