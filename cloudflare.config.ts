import {defineConfig,bindings,triggers} from 'cf/config';

// The first remote deployment is a feasibility probe, with no cron or Telegram.
const spike={
  accountId: 'c0caa75e344cbfbb5ad55cfc712bbc30',
  worker: {
    name: 'crawling-air-tickets-spike',
    entrypoint: './src/worker/spike.mjs',
    compatibilityDate: '2026-10-06',
    compatibilityFlags: ['nodejs_compat'],
    observability: {enabled: true},
    workersDev: true,
    env: {
      PROBE_QUEUE: bindings.queue({name:'crawling-air-tickets-spike-jobs'}),
      STORAGE_CHECK: bindings.d1({name:'crawling-air-tickets-spike-storage'}),
    },
    triggers: [triggers.queue({name:'crawling-air-tickets-spike-jobs',maxBatchSize:1,maxBatchTimeout:1,maxConcurrency:1,maxRetries:0})],
  },
};
export default defineConfig(({mode})=>mode==='production'?{
  accountId:spike.accountId,
  worker:{name:'crawling-air-tickets',entrypoint:'./src/worker/app.mjs',
    compatibilityDate:'2026-10-06',compatibilityFlags:['nodejs_compat'],workersDev:true,
    observability:{enabled:true},
    env:{DB:bindings.d1({name:'crawling-air-tickets-state'}),JOBS:bindings.queue({name:'crawling-air-tickets-jobs'})},
    triggers:[triggers.queue({name:'crawling-air-tickets-jobs',maxBatchSize:1,maxBatchTimeout:1,maxConcurrency:1,maxRetries:5}),
      triggers.scheduled({schedule:'*/10 * * * *'}),triggers.scheduled({schedule:'0 0 * * *'})],
  },
}:spike);
