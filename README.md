# BSE Trade Data API

Standalone Express 5 / PostgreSQL service with `pg` pooling. All trades are fictional synthetic data; prices are INR scenario values, not live market quotes. No Redis, cron, scheduler, or polling worker is required.

## Installation and database setup

Requires Node.js 22+ and PostgreSQL 14+; verified with Node 24 and PostgreSQL 18.

```powershell
npm install
Copy-Item .env.example .env
# Edit .env with your PostgreSQL credentials.
npm run db:create
npm run migrate
npm run seed
npm start
```

The service listens at `http://localhost:4001`. On Windows where PowerShell blocks npm.ps1, use `npm.cmd`. For development reload use `npm run dev`.

`db:create` connects to the existing `postgres` database and creates `bse_trades` if absent. The account needs CREATEDB privileges. Alternatively an administrator can execute `CREATE DATABASE bse_trades;` in psql. For an already provisioned cloud database, skip `db:create` and set its `DATABASE_URL`; runtime and migrations do not hardcode the database name.

Migrations run in a transaction under an advisory lock. `schema_migrations` tracks checksums and skips applied files. Never edit applied migrations; add a numbered SQL migration. No tables are dropped. Conflicting pre-existing unmanaged tables cause rollback for explicit reconciliation.

Seeding inserts 10,000 IDs (`BSE-TRD-000001` to `BSE-TRD-010000`) using 500-row parameterized batches in one transaction. `ON CONFLICT DO NOTHING` prevents duplicates and preserves existing trades. Rerunning inserts zero records; unrelated manually added records are retained. The fixed random seed generates 10 specified symbols, 100 fictional clients, and quantities 1–5000. Stock-specific prices vary around synthetic scenario values.

`seed_metadata` persists the first reference time so reruns reproduce identical values, including timestamps. For reproduction in a fresh database, set `SEED_REFERENCE_TIME` to the same ISO timestamp. By default timestamps fall within the 30 days before the first seed run.

## Environment configuration

`.env` and credentials are ignored by Git; `.env.example` contains placeholders only.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4001` | HTTP port |
| `DATABASE_URL` | required | PostgreSQL URL; percent-encode special password characters |
| `NODE_ENV` | development in example | Set production when deploying |
| `DEFAULT_DELAY_MS` | `0` | Default synchronous trade request delay |
| `MAX_DELAY_MS` | `900000` | Maximum allowed delay, configurable 0–900000 |
| `DEFAULT_EXTRACTION_DELAY_MS` | `0` | Default extraction delay |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins; `*` allows all; no credentialed CORS |
| `PG_POOL_MAX` | `10` | Pool capacity, minimum 2; worker reserves one connection |
| `PG_SSL_CA_FILE` | unset | Optional trusted PEM CA path for verified cloud TLS |
| `SEED_REFERENCE_TIME` | first seed time | Optional initial seed reference timestamp |
| `TEST_DATABASE_URL` | DATABASE_URL | Optional separate integration database |

Connection timeout is 5 seconds; SQL statement timeout is 20 seconds. Connections use UTC. NUMERIC prices remain JSON strings and timestamps preserve microseconds.

## API endpoints

| Method | Endpoint | Function |
| --- | --- | --- |
| GET | `/health` | API/database/worker readiness; 503 if unavailable |
| GET | `/getTrades` | Filtered trade pages |
| GET | `/trades/:tradeId` | Single trade; 404 if missing |
| GET | `/symbols` | Sorted distinct symbols |
| GET | `/stats` | Total trades, symbols and clients |
| POST | `/extractions` | Start durable extraction; 202 Accepted |
| GET | `/extractions/:jobId` | Status and metadata |
| GET | `/extractions/:jobId/results` | Completed snapshot pages |

### Trade requests

`/getTrades` supports `limit` (integer 1–1000, default 100), opaque `cursor`, uppercase `symbol`, inclusive `from` and `to` (ISO timestamps with timezone), and `delay` in milliseconds. Unknown/repeated parameters, invalid dates, inverted ranges, excessive limits/delays and malformed cursors return 400. Unknown valid symbols return empty pages.

Ordering is `timestamp DESC, trade_id DESC`. Use `nextCursor` with the same filters; the final page has `nextCursor: null`. Live trade pages reflect each request's database state; extraction provides a frozen result set.

```sh
curl 'http://localhost:4001/health'
curl 'http://localhost:4001/getTrades?limit=100&symbol=TCS&delay=5000'
curl 'http://localhost:4001/getTrades?symbol=TCS&from=2026-10-01T00:00:00Z&to=2026-10-13T23:59:59Z'
curl 'http://localhost:4001/getTrades?limit=100&symbol=TCS&cursor=PASTE_NEXT_CURSOR'
curl 'http://localhost:4001/trades/BSE-TRD-000001'
curl 'http://localhost:4001/symbols'
curl 'http://localhost:4001/stats'
```

On Windows PowerShell use `curl.exe`. Date ranges should match your seed reference; percent-encode `+` in query timezone offsets.

Illustrative response (values depend on seed reference):

```json
{
  "success": true,
  "count": 1,
  "nextCursor": null,
  "data": [{
    "trade_id": "BSE-TRD-000001",
    "client": "CLIENT-042",
    "symbol": "TCS",
    "quantity": 150,
    "price": "3245.50",
    "timestamp": "2026-10-12T10:30:00Z"
  }]
}
```

Stats response: `{"success":true,"data":{"total_trades":10000,"total_symbols":10,"total_clients":100}}`.

### Simulated delays

Use `delay=5000` or set `DEFAULT_DELAY_MS=5000` and restart. Explicit `delay=0` overrides the default. `MAX_DELAY_MS` can reduce the allowed maximum. The asynchronous timer holds no database connection and keeps the event loop responsive. A disconnected synchronous request cancels its delay.

The server supports 15-minute synchronous delays, but client/proxy timeouts may be shorter. For long processing use extraction instead.

### Asynchronous extraction workflow

POST accepts JSON containing optional `symbol`, `from`, `to`, and `delay`, plus the paired callback registration fields described below. Pagination parameters are not accepted. Processing delay is configurable up to 900000 ms subject to `MAX_DELAY_MS`.

```sh
curl -i -X POST 'http://localhost:4001/extractions' \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"TCS","delay":900000}'
```

The POST waits only for a short snapshot transaction, never for the processing delay. A single `INSERT SELECT` copies the matching trade values and commits them with the job metadata before acknowledgement. Example 202 response, with a `Location` header:

```json
{
  "success": true,
  "jobId": "26cdac89-4afb-4b26-a433-d69a4c870adb",
  "status": "pending",
  "statusUrl": "/extractions/26cdac89-4afb-4b26-a433-d69a4c870adb",
  "resultsUrl": "/extractions/26cdac89-4afb-4b26-a433-d69a4c870adb/results"
}
```

After the processing period, make separate HTTP requests:

```sh
curl 'http://localhost:4001/extractions/JOB_ID'
curl 'http://localhost:4001/extractions/JOB_ID/results?limit=100'
curl 'http://localhost:4001/extractions/JOB_ID/results?limit=100&cursor=NEXT_CURSOR'
```

Status metadata includes `job_id`, `status`, `filters`, `delay_ms`, `ready_at`, `total_records`, `error`, `created_at`, `started_at`, and `completed_at`. States progress pending → processing → completed, or failed on a processing error. Before completion, results return 409 `EXTRACTION_NOT_READY`; failed jobs return 409 `EXTRACTION_FAILED`.

Result pages use the same shape as `/getTrades`, accept only `limit`/`cursor`, cap pages at 1000 rows, and never simulate delay. Indexed queries and a 20-second SQL timeout keep normal result requests under 30 seconds with adequate deployment capacity/network; timeouts return 503. No HTTP connection is held for the processing period.

Copied results observe one consistent PostgreSQL statement snapshot. Subsequent trade inserts, changes or deletions do not affect them. Processing survives initiating HTTP disconnects, and no transaction/connection remains open during the delay.

**Events and recovery:** a committed job emits an in-process event that arms an independent non-blocking one-shot timer. At startup the worker obtains a session advisory lock and performs one recovery scan for pending/processing jobs. It restores timers using persisted `ready_at`; overdue jobs complete immediately. There is no periodic scan, status polling loop, cron or scheduler. Graceful shutdown cancels timers and retains durable jobs. Worker connection loss stops the service so a process manager can restart it. If a database outage prevents persisting a failure, startup recovery retries that durable job.

Run **one service replica per database schema**; a second worker is rejected by the lock. Jobs inserted directly by SQL after startup do not emit service events. Metadata/snapshots are retained until an administrator explicitly deletes them; there is no automatic cleanup scheduler. Repeating a POST without an idempotency key creates a separate job. Trade endpoints and extraction submission have no authentication; use your deployment's access control if needed. Notification administration requires the webhook bearer secret.

### TradePulse completion callbacks

Existing calls without registration continue to work. To register a completion notification, provide **both** `callbackUrl` and `clientJobId` (TradePulse's UUID). These are registration metadata, never trade filters. The 202 receipt, extraction status and cursor result response shapes are unchanged, including early 409 `EXTRACTION_NOT_READY`.

Configure BSE's ignored `.env` before starting:

```env
BSE_WEBHOOK_SECRET=<random shared secret of at least 32 characters>
BSE_CALLBACK_ALLOWLIST=http://localhost:4000/api/bse/notifications
BSE_WEBHOOK_TIMEOUT_MS=10000
BSE_WEBHOOK_MAX_ATTEMPTS=6
BSE_WEBHOOK_RETRY_BASE_MS=1000
BSE_WEBHOOK_RETRY_MAX_MS=300000
```

Generate a secret locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and configure the same value independently on TradePulse. Keep it out of version control, registration bodies, URLs and logs. Empty BSE secret disables callback registration (503 `WEBHOOK_NOT_CONFIGURED`) while preserving non-callback extractions. Configured secrets require 32–512 printable non-space ASCII characters.

```sh
curl -i -X POST 'http://localhost:4001/extractions' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tradepulse-request-unique-key' \
  -d '{"delay":900000,"symbol":"TCS","clientJobId":"c6f6d735-52be-4e67-ae19-c5b7d968c2f0","callbackUrl":"http://localhost:4000/api/bse/notifications"}'
```

After the extraction's terminal transaction commits, BSE sends a POST with `Authorization: Bearer <BSE_WEBHOOK_SECRET>` and `Content-Type: application/json` to the stored approved URL:

```json
{
  "externalJobId": "26cdac89-4afb-4b26-a433-d69a4c870adb",
  "clientJobId": "c6f6d735-52be-4e67-ae19-c5b7d968c2f0",
  "status": "completed"
}
```

Failed extractions send the same identifiers with `status: "failed"`. No trades or secrets appear in notification bodies. Any 2xx acknowledges delivery; TradePulse normally returns 202 after durable acceptance and then ingests cursor results in the background. BSE stops waiting at acknowledgement headers and never waits for ingestion or dashboard updates. Callbacks may arrive before a caller observes its extraction receipt, so TradePulse must correlate on its own `clientJobId` as well as `externalJobId`.

`BSE_CALLBACK_ALLOWLIST` lists exact callback origin/path combinations, including scheme, host and port. No wildcard matching, credentials, fragments or query strings are allowed. Stored destinations are checked again on every dispatch. Development defaults explicitly to the local TradePulse URL; production defaults to no allowed destination and requires HTTPS. Configure only the approved TradePulse recipient because all allowlisted destinations use the same secret. Protect the allowlist, DNS and outbound network policy in cloud hosting; localhost works only in the same machine/network namespace.

### Durable outbox and retry recovery

Migration `002_callbacks_and_idempotency.sql` adds nullable registration/idempotency fields and `extraction_outbox`; it does not alter or reseed source trades. Deploy with `npm run migrate`, then restart BSE. Existing jobs without registration do not acquire callbacks retroactively.

Terminal extraction status and its unique `(job_id, terminal_status)` event are committed in one transaction. An event wakes the outbox only after commit. Delivery failure changes only outbox state, never completed extraction status or results. Atomic claims and the worker's schema session lock prevent competing workers from taking the same transition. There is a possible repeated delivery if BSE exits after TradePulse accepts but before recording acknowledgement; delivery is **at least once**, and TradePulse must deduplicate identical job/status correlations.

Outbox states are `pending`, `delivering`, `retry`, `delivered`, `permanent_failure`, and `exhausted`. Attempts, per-redelivery-cycle attempts, next attempt time, HTTP status and bounded generic diagnostic codes are durable. Receiver response bodies and raw network error strings are not stored or logged.

Each known notification uses its own one-shot timer. Network failures, disconnects, HTTP timeouts, 429 and 5xx retry with bounded exponential backoff. `Retry-After` seconds or dates can increase the delay up to the configured cap. Defaults are a 10-second whole-HTTP-exchange deadline (configurable 100–25000 ms), six attempts (1–20), a 1-second base and a 5-minute cap (up to 15 minutes). Response headers/body are bounded at 16 KB; redirects are never followed. Other non-2xx responses are permanent failures. A retry cycle stops at its configured attempt limit and remains inspectable.

At startup the service scans unfinished outbox rows once, recovers interrupted claims, and arms persisted next-attempt timers alongside the extraction recovery scan. Recovered delivery is deferred until the source HTTP listener is ready so TradePulse can fetch results immediately. Shutdown aborts active HTTP sends and preserves state. An interrupted attempt counts toward the retry limit. Database failure that prevents recording delivery state stops the worker for process-manager restart. There are no recurring queue scans, extraction-status polling loops, setInterval timers, cron jobs or frontend polling in BSE.

### Notification status and explicit redelivery

Both administration endpoints require the same bearer secret. Supply authentication securely rather than placing the secret in URLs or committing it in a command file.

| Method | Endpoint | Function |
| --- | --- | --- |
| GET | `/extractions/:jobId/notification` | Delivery state, attempts, next attempt and diagnostic metadata |
| POST | `/extractions/:jobId/notification/redeliver` | 202: start a fresh retry cycle for a delivered, permanent or exhausted notification |

Redelivery retains identifiers and lifetime attempt count, resets cycle attempts, and revalidates the destination. Its empty body cannot change a destination or secret. Already pending/active delivery returns 409 `NOTIFICATION_ACTIVE`; absence of a terminal registered event returns 404 `NOTIFICATION_NOT_FOUND`. Delivered notifications can be deliberately redelivered, so duplicate handling is testable. Authentication failure returns 401. Failed/exhausted rows are never silently removed.

### Submission idempotency

`POST /extractions` durably supports `Idempotency-Key` (1–200 letters, digits, dots, underscores, colons or hyphens). Concurrent equivalent requests share one extraction and snapshot, returning the original short 202 job receipt. Reuse with different effective filters, delay or callback metadata returns 409 `IDEMPOTENCY_CONFLICT`. Timestamp offsets/fractional formatting, UUID case and normalized equivalent callback URLs do not create false conflicts. Defaults are resolved before comparison; changed server defaults can conflict with a retry that omitted those values, so clients should submit explicit delay when required. Keys persist for the retained job's lifetime. No key preserves the previous create-a-new-job behavior.

### TradePulse configuration and deployment

After BSE's migration and idempotency verification, configure TradePulse independently:

```env
BSE_COMPLETION_MODE=webhook
BSE_CALLBACK_URL=http://localhost:4000/api/bse/notifications
BSE_WEBHOOK_SECRET=<same random secret configured on BSE>
BSE_SUPPORTS_IDEMPOTENCY=true
```

In cloud hosting, both the TradePulse URL and BSE allowlist must use the publicly reachable HTTPS backend callback. Restart both services after configuration/migrations. Start a pull from TradePulse and confirm ingestion and its event-driven dashboard update without `/refresh` or reloading. This repository does not modify TradePulse code, configuration or database; tests exercise a separate durable HTTP receiver fixture. Production end-to-end verification requires a running correctly configured TradePulse receiver and its dashboard.

### Error responses

Errors use `{"success":false,"error":{"code":"INVALID_PARAMETER","message":"limit must be an integer between 1 and 1000"}}`.

HTTP codes: 400 invalid input/JSON, 401 invalid notification-admin authentication, 404 missing resource/route, 409 extraction not ready/failed or conflicting idempotency/redelivery, 413 JSON body over 16 KB, 503 database/worker unavailable or callbacks unconfigured. Internal database details and connection credentials are never returned. SQL values are parameterized.

## Tests

```sh
npm test
npm run test:integration
npm run test:webhooks
```

Validation and HTTP error tests run without PostgreSQL. Integration tests require `TEST_DATABASE_URL` or `DATABASE_URL`; otherwise the PostgreSQL test is explicitly skipped. Tests create a unique temporary schema, migrate/seed it and drop only that schema. The account needs CREATE schema privileges. Tests never truncate your application trades; schema-scoped worker locks allow a live service to coexist with the test schema.

Coverage: exactly 10,000 seed records and idempotency; migration reruns; constraints; full pagination and microsecond ties; symbol/date filters; delays and responsiveness; prompt 202 acknowledgement; consistent paginated extraction snapshots; pending/processing restart recovery; worker exclusivity; persisted processing failure; malformed inputs and unavailable database responses. Logs for intentionally injected failures are expected.

Webhook fixtures additionally exercise real authenticated HTTP, completed/failed callbacks, duplicate correlation and durable receiver deduplication, early callback before receipt, timeout/retry/downtime, worker and actual source-process restart with pending delivery, interrupted delivery recovery, forbidden stored URLs, transaction rollback on outbox insertion failure, racing terminal events, permanent/exhausted failure and redelivery, equivalent/conflicting concurrent idempotency, and a real **31-second extraction**. The test waits on the callback event, not an extraction-status polling loop. It does not claim a 15-minute run. Isolated fixture source fingerprints must remain identical.

## Cloud deployment

Supply secret `DATABASE_URL`, `NODE_ENV=production`, `PORT` and allowed CORS origins. Provision PostgreSQL, run migrations as a release step, optionally seed, then run `npm start`. No code changes are needed when changing PostgreSQL hosts.

Use provider-required TLS with certificate verification, e.g. `sslmode=verify-full`. For a custom trusted CA, use `PG_SSL_CA_FILE` without competing SSL parameters in the URL, since pg connection-string SSL options can replace the explicit CA. Do not disable certificate verification. Budget pool capacity; one connection is reserved for the worker lock.

Deploy as a persistent Node service with one replica and automatic restart on exit. Use a direct PostgreSQL connection or session pooling: transaction pooling does not preserve session advisory locks. Request-scoped serverless runtimes do not support this timer lifecycle. Configure reverse proxy timeouts over 15 minutes only for synchronous delays; asynchronous status/results need ordinary short timeouts. Back up PostgreSQL to retain jobs and snapshots.

## Project layout

- `src/app.js`, `src/server.js`: composition and lifecycle.
- `src/routes/`, `src/controllers/`, `src/services/`: HTTP and domain modules.
- `src/db/`, `src/config.js`, `src/validation.js`, `src/errors.js`: pooling, configuration, validation and error handling.
- `migrations/`, `scripts/`: schema setup and reproducible seed.
- `tests/`: built-in Node HTTP and PostgreSQL tests.
- `db.js`: compatibility export for the original database module.
