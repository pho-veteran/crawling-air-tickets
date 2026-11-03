# D1 storage preparation and local import validation

Production is now active; see [the current runbook](cloudflare-production.md). The user authorized the verified agency sources, waived separate staging/24 hours, and replaced timeline retention with current prices plus minima. The original full import was reconciled and backed up, then compacted to two current records, zero time-series quote rows and six minima. `RuntimeStore.observeCurrent` performs a fenced atomic replacement/minimum update. Completed jobs and delivered outbox messages discard their pricing payloads; operational ACK/cooldown timestamps remain.

The sections below document the **original import/archive contract**, retained for backup and recovery. They do not describe production pricing retention.

## Implemented storage contract

`migrations/0001_storage.sql` defines observations, normalized positive quotes,
all-time minima, subscribers, lossless legacy documents and expiring leases.
`src/storage/d1.mjs` uses the D1 prepare/bind/batch interface; filesystem access
and the offline SQLite adapter remain under `scripts/`.

- Snapshot + quotes + minima are committed in one batch transaction.
- Repeated observation IDs with identical content are idempotent. Different
  content under an existing ID fails without overwriting the old observation.
- Error snapshots are retained but do not contribute price/minimum candidates.
  Invalid zero/negative/non-integer prices fail planning instead of becoming lows.
- History is indexed by source/query/timestamp/ID and paged with a stable cursor,
  including multiple observations at the same timestamp.
- Leg quotes use `legs_source`, separate from roundtrip source identity.
- Rolling minima use indexed date/source/window queries. All-time minima have no
  foreign key to raw history, so retention does not erase the previous minimum.
- `pruneBefore` deletes bounded batches and cascades quote deletion. It is an
  explicit maintenance operation and is not scheduled in the current probe.
- Lease acquisition uses one conditional upsert; owner + monotonically increasing
  epoch fence renew/release after takeover. A release keeps a tombstone so the
  same owner cannot accidentally reuse an epoch.

Production now fences effectful D1 commits using the lease owner, epoch and expiry checked inside each transaction. Telegram delivery renews ownership before its external call. Worker orchestration regression tests cover expired-owner rejection, duplicate updates, opt-out ordering, retries and 429 cooldown.

Bulk quote insert uses a multi-row `VALUES` CTE, at most 92 bind parameters per
statement. Real D1 rejected the earlier ten-term `UNION ALL SELECT`; its compound
SELECT limit is five. D1 validation, not a local SQLite pass, established the
corrected SQL's compatibility. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Live isolated D1 test

Database: `crawling-air-tickets-spike-storage`, ID
`f01204b3-4dce-4b71-8006-9c75f2c37bd2`. It contains the migration and bookkeeping
tables; the successful diagnostic cleans its own data rows. No private subscriber
or history import has been performed on Cloudflare.

Latest measured Worker version: `0db6e6f4-668d-4e73-9c27-eae57f6cdb7d`.
Correlated run: `8bebaff0-b655-4610-97a2-9311c799c9d8`, approximately 21:33 Vietnam
time on 12 October 2026. The diagnostic uses a recorded normalized Flynow payload
explicitly marked as a fixture, not new provider requests or fixed live-price
assertions.

| Measurement | Observed value |
| --- | ---: |
| Queue consumer CPU | 19 ms |
| Queue consumer wall time | 6,043 ms |
| Fixture JSON bytes | 43,953 |
| Quote dimensions | 63 |
| Attempted SQL statements | 40 |
| Successful SQL statements with returned metadata | 38 |
| Deliberately failing batches | 1 |
| Rows read reported by successful statements | 606 |
| Rows written reported by successful statements | 457 |
| Sum of successful D1 SQL durations | 14.4389 ms |

All eight live checks passed: idempotent snapshot, history roundtrip, minimum,
subscriber opt-out, expired lease takeover/stale-owner rejection, atomic batch
rollback on an invalid quote, minimum surviving history deletion, and FK cascade.
[Batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
are verified on D1 itself, not inferred from the offline adapter.

Rows above include a repeated insert, lease/subscriber/legacy-document work,
reads and fixture cleanup. Metadata is unavailable for the deliberately aborted
batch. These counters **are not the per-crawl production cost**. Full-app quota
validation must measure the final writes/indexes, unchanged-price polls, rolling
reads, jobs, outbox, retries and subscriber fan-out. The schema estimate in the
spike report is still an estimate, not that validation.

To reproduce without calling VNA/Flynow or sending Telegram messages:

```powershell
cf.cmd d1 migrations list f01204b3-4dce-4b71-8006-9c75f2c37bd2 --dir migrations
cf.cmd d1 migrations apply f01204b3-4dce-4b71-8006-9c75f2c37bd2 --dir migrations
npm.cmd run cf:probe -- --storage
node scripts/cloudflare-spike-report.mjs
```

`cf:probe` initializes the `trace-v1` WebSocket like Wrangler, saves only sanitized
metrics/logs and fails if no correlated completion was seen. If live tail fails,
use persisted Workers Logs and correlate the `run_id` log with its invocation's
request ID. An HTTP 202 only proves durable enqueue, not consumer completion.

## Local import and backup

Run from the repository:

```powershell
npm.cmd run cf:import:check
npm.cmd run cf:import:snapshot
```

The first command plans all inputs before any database write, imports into an
in-memory SQLite database, reconciles observations/quotes/minima/subscribers and
legacy state, and repeats the import to check idempotency. It saves a summary in
ignored `data/cloudflare-import-validation.json`. It is an offline check, not a
remote D1 import.

The second command additionally creates a uniquely named, ignored
`data/cloudflare-import-<timestamp>-<UUID>/` directory containing exact captured
input bytes, `import.sqlite` and `manifest.json`. It never overwrites an existing
backup. A failed validation leaves `FAILED.json`; do not use a failed snapshot
for cutover. Private backup/state files must not be committed or uploaded as a
public artifact.

Inputs are limited to `history.jsonl`, `telegram-subscribers.json`,
`notification-state.json`, `daily-state.json` and `bot-state.json`. `.env`, logs,
lock files and stop requests are excluded. File hashes are checked again after
import to reject a snapshot that changed during capture/validation. Keep the
local bot authoritative; if concurrent writes invalidate a check, repeat on a
stable snapshot without modifying the original data.

The latest offline dry-run at **21:32:33 Vietnam time** verified 118 observations,
6,237 valid quotes, 189 all-time minima, 2 subscribers and 3 legacy documents.
The verified backup at **21:25:49** contains 116 observations and 6,111 quotes;
the local bot continued appending between those checks. Every repeated import
inserted zero additional observations. Counts deliberately include legacy Vietjet
source identities, with their minima kept separate from the Flynow source.

ACKs, pending events, retry timing, broadcast cooldown, listener cursor and opt-out
metadata are preserved losslessly in legacy documents. **They have not yet been
translated into a live Worker outbox/update ledger.** Keeping the raw documents
is evidence of lossless capture, not evidence that cloud delivery dedupe works.

`applyImport` rejects an existing destination with different observations,
subscriber opt-outs or legacy ACK/cooldown state before adding data. It supports
idempotent resume against the same capture. It must not be called against a live
bot database without the cutover/reconciliation protocol.

## Rollback boundaries

At this phase rollback simply keeps the local installation running: no webhook
has changed, no local files were rewritten and no cloud production import exists.
The schema is additive and isolated to the spike DB.

For the eventual cutover, make a fresh verified capture, import into an isolated
staging/production database and reconcile the live outbox mapping before enabling
sends. Stop local long polling before setting a webhook. On rollback remove the
webhook before restarting local listening, and reconcile any subscribers/ACKs
created on Cloudflare after the capture. Blindly replacing the local files with
an older backup would lose those updates and can resend notifications.

Do not run a destructive down-migration or restore over an active database.
Remote D1 export/Time Travel restoration and post-cutover state reconciliation
are not implemented or verified by these local backup commands.
