# Cloudflare Workers feasibility spike

**Cập nhật 13/10/2026:** [scope hai ngày chính và nguồn VNA qua Flynow](cloudflare-selected-dates.md) thay thế scope 49 ô và blocker nguồn bên dưới. Các số liệu ngày 12/10 được giữ làm bằng chứng lịch sử.

Status on **12 October 2026 (Vietnam time, UTC+7)**:
the probe is deployed, but migration is **not approved for production**.
The source gate in [issue #1](https://github.com/pho-veteran/crawling-air-tickets/issues/1)
failed for VNA. No Telegram webhook, cron, production secrets or D1 import has
been enabled. The local bot and its data remain authoritative.

## Deployment and evidence

- Worker: <https://crawling-air-tickets-spike.thanhvinhlqt2016.workers.dev/health>
- Latest version: `0db6e6f4-668d-4e73-9c27-eae57f6cdb7d`.
- Probe Queue: `crawling-air-tickets-spike-jobs`, batch size 1, concurrency 1,
  maximum retries 0, retention 24 hours. It has no scheduled producer.
- [Correlated, sanitized evidence](cloudflare-spike/evidence.json) contains run
  IDs, source HTTP statuses, prices and invocation CPU/wall time. Full normalized
  results and sanitized tail logs are in ignored `data/cloudflare-*.json` files.
- Runtime: compatibility date `2026-10-06`, `nodejs_compat`, account usage model
  `standard`. No paid upgrade or custom CPU limit was requested.
- `GET /health` returned 200. Unauthenticated `POST /probe` returned 401.
  A bearer secret is required for either probe endpoint.

## Live results

Query: SGN–VCL, outbound 2027-02-04, return 2027-02-13, one adult,
including the existing ±3-day calendar behavior.

| Test | Observed result |
| --- | --- |
| VNA fare matrix from Worker | HTTP 403, approximately 129 ms to headers |
| VNA outbound one-way from Worker | HTTP 403, approximately 129 ms to headers |
| VNA inbound one-way from Worker | HTTP 403, approximately 129 ms to headers |
| Same three VNA requests from local Node | HTTP 200; normalization and both legs `ok` |
| Local VNA main roundtrip | 10,184,362 VND, observed 20:59:04 Vietnam time |
| Flynow via Worker HTTP probe | 7 HTTP 200 responses; 49 priced cells; main roundtrip 9,761,562 VND |
| Whole HTTP probe | 10 attempted source subrequests; 33 ms CPU; 4,416 ms invocation wall time |
| Flynow via Queue consumer | 7 source subrequests; 49 priced cells; same main roundtrip; 21 ms CPU; 6,845 ms wall time |
| Queue producer HTTP endpoint | HTTP 202 after durable enqueue; 1 ms CPU; 351 ms wall time |

These are individual live samples, not a stability or capacity benchmark. Price
values are observations and must not become fixed-price assertions in tests.
Flynow prices still use `TotalFare + TotalTax = TotalPrice - TotalServiceFee`,
with zero verified discounts and available direct flights. Its neighboring
matrix remains the sum of independent one-way prices. VNA's roundtrip and
independent one-way bases remain separate.

VNA is reachable with the same application payload on the local machine but
returns 403 on the Cloudflare path. This establishes the access failure; it does
not establish which server rule caused it. No alternative IP, proxy, fabricated
browser headers or protection bypass was attempted. Provider requests have no
automatic retry within a crawl.

Workers reject `fetch` with `redirect: 'error'`. The Worker transport maps it to
`manual`, and provider checks reject non-2xx statuses. Redirects are never followed.
The first probe discovered this runtime incompatibility before sending source
requests; the quoted results come from the corrected deployment.

## Free budget and architecture implication

[Workers Free](https://developers.cloudflare.com/workers/platform/limits/)
allows 100,000 incoming requests/day, 10 ms CPU for HTTP/cron, 128 MB memory,
50 external subrequests per invocation and 6 concurrent outgoing connections.
The existing crawl attempts 10 source requests with at most 5 in flight. At
10-minute intervals this is 144 crawls/day and 1,440 source requests/day, before
on-demand work. Source requests are subrequests, not 1,440 incoming webhooks.

The synchronous HTTP crawl used more than the 10 ms CPU allowance. Its successful
response does not make that design safe to run regularly: Cloudflare documents
occasional CPU flexibility. HTTP and cron should enqueue work and return promptly.
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/) describe
a 30-second default consumer CPU limit and a 15-minute wall limit. The observed
21 ms consumer invocation completed on this account. This supports the proposed
Queues design for Flynow; it does not replace real benchmarks for the full app,
VNA, D1, webhook, cron, broadcasts, timeouts or repeated invocations.

[Queues Free](https://developers.cloudflare.com/queues/platform/pricing/) includes
10,000 operations/day with 24-hour retention. A message under 64 KB normally
uses three operations: write, read, delete. Store snapshots in D1 and put job IDs
in messages. Retries add reads and a dead-letter enqueue adds a write.

For a candidate design with one crawl job per scheduled/on-demand run, one daily
job, and one delivery job per recipient/message, estimate:

```text
S = active subscribers
P = on-demand crawls/day
A = alert message parts per subscriber/day (all airlines/directions combined)
normal queue operations/day = 3 × (144 + 1 + P + S × (1 + A))
```

This excludes startup/import/recovery jobs, retry operations and messages over
64 KB. Do not use the estimate as a substitute for measured counters.

| Scenario | Normal queue operations/day |
| --- | ---: |
| Current local 2 active subscribers, P=10, A=10 | 531 |
| S=10, P=10, A=10 | 795 |
| S=100, P=10, A=20 | 6,765 |
| S=100, P=10, A=30 | 9,765 (insufficient reserve) |

Use an operational target below 8,000 operations/day to leave 20% for failures
and administrative work. Alerts can be multiple parts; count the actual parts,
not just price events. An application must handle retained jobs expiring during
outages longer than 24 hours using durable job/outbox reconciliation.

[D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) includes
5 million rows read/day, 100,000 rows written/day and 5 GB total storage. An
illustrative normalized crawl has 2 snapshots + 98 cells + 28 leg-date rows =
128 rows; 144 such crawls gives 18,432 inserted rows/day before jobs, outbox,
  updates, indexes and retention. Index writes also count. This is a schema
estimate, not measured D1 usage. Never scan all historical rows every crawl:
maintain all-time minima and indexed rolling-window queries. Actual D1 schema,
storage growth and full-app row counters are still unverified. The initial schema,
offline importer and isolated live D1 fixture checks are now implemented; see
[storage evidence and limits](cloudflare-storage.md). Those fixture counters do
not establish the final application's daily D1 budget.

Per-invocation memory was not measured. CPU and wall time are the platform's
correlated tail metrics; source response byte counts are not memory usage.

## Reproduce

The CLI local remains usable without installing dependencies. Cloudflare
development uses the pinned `cf`, Wrangler and `ws` dev dependencies:

```powershell
npm.cmd ci
cf.cmd auth login
npm.cmd run cf:check
npm.cmd test
```

Create an ignored `.env.spike` containing a random `PROBE_SECRET` (the current
machine already has one). Never use `.env` with the production Telegram token
as the deploy secret file. Deploy the explicitly named feasibility Worker:

```powershell
npm.cmd run cf:deploy:spike
```

After legitimate VNA access is available, `npm.cmd run cf:probe` runs one full
HTTP source probe. While the VNA gate is unresolved, use only the Flynow consumer
probe when another measurement is needed:

```powershell
npm.cmd run cf:probe -- --queue
node scripts/cloudflare-spike-report.mjs
```

The helper creates a temporary tail session, correlates its event with the run
ID and removes the session. It reads the existing cf OAuth credential internally
from its Windows profile, or accepts `CLOUDFLARE_API_TOKEN`; `CF_AUTH_FILE` overrides
the profile path. Credentials, tail capability URLs, request headers and payload
bodies are excluded from saved evidence. OAuth profiles must already be valid;
the helper itself does not refresh them, so run `cf auth whoami` first if needed.

The Queue consumer probe is a measurement tool, not production job processing:
it does not implement durable dedupe, D1 leases, outbox or recovery. It deliberately
acks source errors and has zero retries to avoid repeated source requests.

## Required next steps

1. Restore legitimate VNA access from Workers: obtain an authorized endpoint or
   server-side access arrangement with VNA. Keep the existing source/price basis
   unless a source change is separately approved. Re-run the source gate once
   access changes, without trying to evade the 403 response.
2. Complete the initial D1 repository/import preparation described in the storage
   report: live outbox/update-ledger translation, remote import/export/rollback,
   owner-fenced effectful commits and job orchestration remain pending. Only
   integrate and approve production migration after the source gate passes.
3. Implement a private-chat Telegram webhook with secret verification,
   `update_id` dedupe and durable ACK; Queue consumers with bounded job retries;
   recipient outbox/cooldown; cron `*/10 * * * *` and `0 0 * * *`.
4. Measure CPU, memory, wall time, subrequests, D1 rows and Queue operations on
   real webhook/cron/consumer payloads and subscriber load, including failures.
5. Run a separate test bot for at least 24 hours through 07:00 Vietnam time,
   redeploy during a job, source timeout, duplicate delivery, Telegram 429,
   lease expiry and midnight transitions. None of these staging gates has run.
6. Import and reconcile history, all-time minima, subscribers, dedupe/outbox.
   Only after all gates pass, stop local long polling before setting the
   production webhook. Rollback must remove the webhook before restoring local
   listening. No production cutover or webhook change has occurred in this spike.

Keeping a local crawler or using an external relay would change the requested
all-Cloudflare deployment and is not the implemented result. Upgrading Workers
would not by itself resolve a VNA 403 response, and no paid upgrade was made.

## Verification

83 offline tests passed, including the existing regression suite, D1 storage and probe tests
for authentication, both normalizers/all neighboring dates, 403 handling and
durable Queue enqueue ACK. Cloudflare build, deployment and live tail succeeded.
The separate Node VNA wrapper retains the verified TLS intermediate; Workers
import the portable core. The normalizers and source identities are unchanged.
