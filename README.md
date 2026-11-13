# health-mcp

A Cloudflare Worker that stores [Health Auto Export](https://healthyapps.dev) JSON (version 2) and a one-time historic Apple Health export, then serves that data to MCP clients.

The Worker is the only server. It uses a D1 database for samples, workouts, and events, and an R2 bucket for bulky series such as workout routes, per-workout heart-rate arrays, ECG voltage, and beat-to-beat readings. A local command streams `export.xml` or the Apple export zip and posts date batches to the Worker. It does not run a second database.

This stores personal health data for your own questions. It is not a medical device and it does not give medical advice.

## What it keeps

Health Auto Export sends one data type per automation, as JSON version 2. The Worker accepts metrics (including blood pressure, sleep, heart-rate and HRV buckets, glucose, nutrition, sexual activity, handwashing, toothbrushing, and insulin), workouts version 1 and 2, symptoms, cycle tracking, medications, state of mind, ECG, and heart-rate notifications. A metric or array it does not recognize is stored rather than dropped.

Daily totals are not the only grain. A heart-rate day is a min, average, and max. Sleep is a night summary or stage segments, dated on the wake day in `HEALTH_TIMEZONE`. Workout routes and other long arrays go to R2. MCP tools return summaries unless you ask for one series page.

## Deploy

Create a new D1 database and an R2 bucket. Do not point this Worker at a database created by version 0.1. Those rows cannot be converted.

```bash
npx wrangler d1 create health-mcp
npx wrangler r2 bucket create health-mcp-series
```

Put the database id into `database_id` in [`wrangler.jsonc`](wrangler.jsonc), set `HEALTH_TIMEZONE` to your zone, then:

```bash
npm install
npx wrangler secret put HEALTH_INGEST_TOKEN
npm run db:migrate
npm run deploy
```

`openssl rand -hex 32` is a reasonable token. Copy `.dev.vars.example` to `.dev.vars` for `wrangler dev`.

Health Auto Export can send `Authorization: Bearer <token>`. Add one REST automation per data type, JSON, version 2, today and yesterday. Leave routes and per-second workout series off unless you want `get_series`. Details are in [docs/sources.md](docs/sources.md).

## Historic Apple import

On your machine, not on the Worker:

```bash
export HEALTH_INGEST_TOKEN=...
npm run import:apple -- ~/Downloads/export.zip \
  --chunk-url https://<worker>/import/apple-health/chunk \
  --time-zone America/Los_Angeles \
  --source-priority "Apple Watch,iPhone"
```

The command streams the export and posts normalized batches. Cumulative days merge Watch and iPhone by time instead of keeping one source for the whole day. Source names match by device class, so `Ryan’s Apple Watch` matches `Apple Watch`. Chunk imports do not use the phone's initial-import window. Posting a date again replaces the Apple-import rows for that date and leaves Health Auto Export rows in place.

## MCP

`POST /mcp` with the same bearer token. Tools are read-only: `get_daily_summary`, `list_metrics`, `query_metrics`, `query_workouts`, `query_events`, and `get_series`. `GET /summary?date=YYYY-MM-DD` returns the same day object as `get_daily_summary`.

Browser clients must send an `Origin` that is listed in `MCP_ALLOWED_ORIGINS`. Clients that omit `Origin` are allowed.

## Limits

Steady state keeps today and yesterday (`INGEST_MAX_AGE_DAYS`, default 1). The first accepted ingest opens an initial import window (72 hours, 60 requests an hour, 5 MB per request, 500 MB total, unless you change the vars). Send `{"backfill":"done"}` or `X-Backfill: done` when the phone has caught up. Dates before `INGEST_MIN_DATE` are dropped.

D1's free plan returns 429 until the next UTC midnight after a daily row limit. The Worker surfaces that as `error: daily_limit`.

## Develop

```bash
npm test
```

Tests run in Workers via `@cloudflare/vitest-plugin` against local D1 and R2. Node 22 or newer.

More: [docs/api.md](docs/api.md), [docs/self-hosting.md](docs/self-hosting.md), [docs/security.md](docs/security.md).
