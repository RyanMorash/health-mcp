# Self-hosting

health-mcp runs only as a Cloudflare Worker. You need a Cloudflare account, a new D1 database, and an R2 bucket.

Version 0.1 used Node, Docker, SQLite, Postgres, and a different D1 schema (`points_daily`). Those hosts are gone. Do not apply `migrations/0001_init.sql` to a database that already ran the 0.1 migrations. Create a new database and import again. The old daily rows cannot be rebuilt into samples, workouts, and events, and Android rows are out of scope.

## Create the resources

```bash
npx wrangler login
npx wrangler d1 create health-mcp
npx wrangler r2 bucket create health-mcp-series
```

Copy the printed database id into `database_id` in [`wrangler.jsonc`](../wrangler.jsonc). The committed id is a placeholder so local tests can boot without an account.

Set `HEALTH_TIMEZONE` in `vars` to an IANA zone, for example `America/Los_Angeles`. Sleep nights and the "today and yesterday" window use that zone. A timestamp that already has a numeric offset uses the offset.

```bash
npx wrangler secret put HEALTH_INGEST_TOKEN
npm run db:migrate
npm run deploy
```

`npm run db:migrate` runs `wrangler d1 migrations apply health-mcp --remote`.

For local development, copy `.dev.vars.example` to `.dev.vars` and set the token, then `npm run dev`.

## Bindings

| Binding | Kind | Use |
| --- | --- | --- |
| `DB` | D1 | Samples, workouts, events, and the import window. Accessed only through `env.DB`. |
| `SERIES` | R2 | Content-addressed JSON for routes, workout series, ECG voltage, and beat-to-beat readings. |

`db.batch()` counts as one subrequest. Workers Logs and traces are enabled in `wrangler.jsonc`.

`workers_dev` is `true`, so deploy publishes a public `workers.dev` hostname. Anyone who learns that hostname and the token can call the API. Set `workers_dev` to `false` and attach your own route when you do not want the `workers.dev` name.

## Vars

| Var | Default | Meaning |
| --- | --- | --- |
| `HEALTH_TIMEZONE` | `America/Los_Angeles` | Calendar zone when a timestamp has no offset. |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to call `/mcp`. Empty rejects any request that sends `Origin`. |
| `INGEST_MAX_AGE_DAYS` | `1` | Days before today that a steady-state ingest may include. |
| `INGEST_MAX_BODY_BYTES` | `1000000` | Steady-state body cap. |
| `INGEST_RATE_LIMIT_PER_HOUR` | `6` | Steady-state posts per hour. `0` turns it off. |
| `INGEST_BACKFILL_HOURS` | `72` | How long the initial import stays open. |
| `INGEST_BACKFILL_MAX_BYTES` | `5000000` | Per-request cap during the import, and the cap for Apple chunks. Hard maximum 10 MB. |
| `INGEST_BACKFILL_MAX_PER_HOUR` | `60` | Posts per hour while the import is open. |
| `INGEST_BACKFILL_MAX_TOTAL_BYTES` | `500000000` | Total bytes accepted before the window must be closed. |
| `INGEST_MIN_DATE` | `2000-01-01` | Earlier dates are dropped on both ingest paths. |

Changing a var requires another deploy. The token is a secret, not a var.

`HEALTH_SOURCE_PRIORITY` is read by the local Apple importer (`Apple Watch,iPhone`). The Worker does not use it. Health Auto Export rows are stored as the app sent them, because that app is where you choose sources.

## Apple import

```bash
export HEALTH_INGEST_TOKEN='the token you set with wrangler secret put'
npm run import:apple -- /path/to/export.zip \
  --chunk-url https://<worker>/import/apple-health/chunk \
  --time-zone America/Los_Angeles
```

Set `HEALTH_INGEST_TOKEN` in the environment yourself. The command does not read it from Wrangler. Prefer the environment variable to `--token`, which shows up in the process list.

The importer streams the zip or `export.xml`. It refuses a zip that looks like a bomb (excessive compression, zip64, encrypted entries, or a huge uncompressed size). If one date batch is still over about 4.5 MB, it splits that batch further.

## Free plan

D1's free daily row limits fail the write. The Worker answers `429` with `error: daily_limit` and `retry-after` until the next UTC midnight. Wait and send the same body again. Upserts make the retry safe.

R2 and Workers free-plan quotas are separate. A route-heavy import writes one R2 object per workout that has a series.
