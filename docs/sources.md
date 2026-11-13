# Sources

The Worker accepts two inputs: Health Auto Export JSON version 2, and normalized batches from the local Apple Health importer. CSV and Markdown are rejected.

## Health Auto Export

Create one REST API automation per data type. HealthyApps documents the catalog (health metrics, workouts, symptoms, cycle tracking, medications, state of mind, ECG, and heart-rate notifications). Use these settings:

- Request: `POST https://<worker>/ingest`
- Header: `Authorization: Bearer <HEALTH_INGEST_TOKEN>`
- Body: JSON, version 2
- Range: today and yesterday, once the initial import is finished
- Routes, per-second workout series, and beat-to-beat HRV: off, unless you want to read them later with `get_series`

The first accepted post opens the initial import window, so a backfill of older days is allowed until the window closes. Close it with a post whose body is `{"backfill":"done"}`, or with the header `X-Backfill: done`. After that, days older than yesterday are rejected with `422`.

A later post of the same sample replaces it. Identity is the metric, time, source, and label, not the quantity, so a correction does not stack a second row.

Special shapes are stored as themselves:

| Shape | What is kept |
| --- | --- |
| Quantity (`qty`, `date`, `source`) | One sample. Energy in kJ or Cal is also stored as kcal. |
| Heart rate and HRV (`Min`, `Avg`, `Max`) | One bucket. Beat-to-beat arrays go to R2. |
| Blood pressure (`systolic`, `diastolic`) | One pair. |
| Sleep summary or stage segments | Dated on the wake day. |
| Blood glucose | `mealTime` kept with the sample. |
| Nutrition | `foodType` kept with the sample. |
| Sexual activity | Counts for Unspecified, Protection Used, and Protection Not Used. |
| Handwashing and toothbrushing | Duration plus the completion label. |
| Insulin | `reason` kept with the sample. |
| Workouts v1 and v2 | Summary columns. Routes, laps, splits, and heart-rate series go to R2. |
| Symptoms, cycle, medications, state of mind, ECG, heart-rate notifications | Event rows. ECG voltage goes to R2. |

An unknown metric name is still stored. An unknown array under `data` is stored as an event.

## Apple Health export

The iPhone export is a zip with `export.xml`, often several gigabytes. The Worker does not parse that file. [`src/cli/import-apple-health.ts`](../src/cli/import-apple-health.ts) streams it on your machine and posts date batches to `POST /import/apple-health/chunk`.

The mapper reads:

- `HKQuantityTypeIdentifier*` and `HKCategoryTypeIdentifier*` (sleep, symptoms, cycle, mindful minutes, stand hours, handwashing, toothbrushing, sexual activity, and other category types)
- `HKCorrelationTypeIdentifierBloodPressure`
- `Workout`, workout statistics, and route GPX when the zip contains it
- electrocardiogram, state of mind, and medication dose elements when the file contains them
- `ActivitySummary` move, exercise, and stand rings only when that metric is missing for the day
- anything else, as an event with its type, time, value, unit, and source

Cumulative quantities (steps, distance, active energy, and the other daily sums) are merged by time. A higher-priority source keeps its intervals, and a lower-priority source adds only the part of the day it alone covered, scaled by that fraction of its sample. `--source-priority` defaults to `Apple Watch,iPhone`. Matching is case-insensitive, ignores straight and curly apostrophes, and treats every iPhone generation as one device and every Apple Watch as one device. `Ryan’s Apple Watch` matches `Apple Watch`. Two iPhones do not both count the same minute.

Weight and other latest metrics keep the newest sample. Heart rate and other min/avg/max metrics keep one source for the day, the highest-priority source that recorded it. Sleep keeps one source for the wake day: the highest-priority source that has asleep stages, otherwise the highest-priority source that has any segment. Clock loses to a real sleep source when it was not listed in the priority.

Posting a chunk again deletes Apple-import samples for the dates in that chunk, then inserts the new rows. Health Auto Export rows on those dates stay. Sample ids used to include the source name, so a rerun that only upserted would leave the other source in place and `query_metrics` would add the two rows. To drop Apple-import rows from dates the new file does not contain:

```bash
npx wrangler d1 execute health-mcp --remote --command "DELETE FROM samples WHERE json_extract(COALESCE(extra, '{}'), '$.apple') = 1"
```

Then run the importer again. No schema migration is required.

Samples on the export day itself are dropped. That day is still in progress in the file. Health Auto Export fills it afterward. If Health Auto Export later stores the same metric on a day the import already filled, summaries and `query_metrics` use the Health Auto Export samples for that day and do not add the Apple total on top.

Chunk posts use the same bearer token. They ignore the recent-day filter and do not draw down the phone's import window. Dates before `INGEST_MIN_DATE` are still dropped.

## Removed

Health Connect, HC Webhook, Life Dashboard, SyncFit, Health Export Pro, and Shortcuts are not accepted. There is no write-only URL token.
