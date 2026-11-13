# API

Every route requires `Authorization: Bearer <HEALTH_INGEST_TOKEN>`. A missing or wrong token is `401` with `WWW-Authenticate: Bearer realm="health-mcp"`. An empty token never matches.

Responses are JSON.

## `POST /ingest`

Health Auto Export version 2. The body is `{ "data": { ... } }` or the `data` object itself. `Content-Type` containing `csv` or `markdown` is `415`. A body that is not JSON is `400`.

Steady state stores today and yesterday in `HEALTH_TIMEZONE` (`INGEST_MAX_AGE_DAYS`, default `1`). The first accepted ingest opens the initial import window. While it is open, or before any ingest has been stored, older dates are kept, subject to `INGEST_MIN_DATE` and the window's byte cap. Dates more than a day in the future are dropped.

Close the window with `{"backfill":"done"}` or the header `X-Backfill: done`. A successful response includes `backfill`: `open`, `closes_at`, and `bytes_remaining`.

| Status | `error` | When |
| --- | --- | --- |
| 200 | | Rows were written, or the window was closed. |
| 400 | `invalid_json`, `invalid_payload` | The body is not a Health Auto Export object. |
| 413 | `payload_too_large` | The body, the number of dates (max 366), or the import total is over the cap. |
| 415 | `unsupported_media_type` | CSV or Markdown. |
| 422 | `outside_window` | Nothing in the body fell inside the dates you can still send. |
| 429 | `rate_limited` | More than `INGEST_RATE_LIMIT_PER_HOUR` posts this hour. `retry-after` is seconds until the next hour. `0` disables the limit. |
| 429 | `daily_limit` | D1 rejected the write for a free-plan daily row limit. `retry-after` is seconds until the next UTC midnight. |

A 200 body includes `samples`, `workouts`, `events`, `dates`, and how many rows were dropped as stale, future, or before `INGEST_MIN_DATE`.

Re-posting the same sample replaces it.

## `POST /import/apple-health/chunk`

Normalized records from `npm run import:apple`. The body is:

```json
{
  "samples": [],
  "workouts": [],
  "events": [],
  "series": [{ "key": "series/<32 hex chars>", "body": {} }]
}
```

This route does not open or close the import window, does not count against the hourly ingest limit, and does not apply the recent-day filter. It still drops dates before `INGEST_MIN_DATE` and dates more than a day ahead. The body cap is `INGEST_BACKFILL_MAX_BYTES` (default 5 MB, maximum 10 MB). More than 366 dates or 20,000 rows is `413`.

## `GET /summary?date=YYYY-MM-DD`

One day: `dietary_kcal`, `protein_g`, `carbs_g`, `fat_g`, `active_kcal`, `basal_kcal`, `steps`, `weight`, `body_fat_pct`, `sleep`, and `workouts`. Sleep hours come from stage segments when those exist, otherwise from the night summary. Workout entries are name, start, duration in minutes, and active kcal. Routes are not included. `export_hint` is present when a recent ingest dropped a large number of stale days.

Energy stored as kJ is reported as kcal. A body-fat fraction of 1 or less is reported as a percent.

## `POST /mcp`

Stateless MCP, implemented with `createMcpHandler` from `agents/mcp`. The handler is created per request. There is no Durable Object.

If the request has an `Origin` header, that origin must appear in the comma-separated `MCP_ALLOWED_ORIGINS`. An empty list rejects every request that sends `Origin` (`403`). Requests without `Origin` are allowed.

Tools are read-only, validated with Zod, and capped at a 366-day span and 500 rows. A longer result sets `truncated`.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_daily_summary` | `date` | The same object as `GET /summary`. |
| `list_metrics` | | Stored metric names and registry kind. |
| `query_metrics` | `metric`, `start_date`, `end_date` | Daily rollup for that kind: sum, latest, or min/avg/max. Heart rate is min/avg/max. Blood pressure is mean systolic and diastolic. Sleep is the day summary. |
| `query_workouts` | `start_date`, `end_date` | Workout summaries. `series_key` is set when a route or series exists. The series is not inlined. |
| `query_events` | `kind`, `start_date`, `end_date` | `symptom`, `cycle`, `medication`, `state_of_mind`, `ecg`, or `heart_rate_notification`. ECG voltage is not inlined. |
| `get_series` | `key`, optional `part`, optional `offset` | One page of an R2 object. Omit `part` to list the arrays in the object. `key` must look like `series/` plus 32 hex characters. |

## Registry kinds

`sum`, `latest`, `min_avg_max`, `blood_pressure`, `sleep`, `duration_label`, `category_count`, and `quantity`. An unknown metric is `quantity` and is summed by `query_metrics`.
