import { isSeriesKey, recordId } from "./id.js";
import {
  activeLimits,
  backfillClosesAt,
  type BackfillView,
  distinctDates,
  hourWindowStart,
  type Settings,
  type WindowRow,
} from "./limits.js";
import { rollupMetric } from "./summary.js";
import type { EventKind, HealthEvent, MetricKind, Normalized, Sample, Workout } from "./types.js";

const BATCH = 80;

interface WindowRecord {
  opened_at: string;
  closed_at: string | null;
  bytes: number;
  days: number;
  deadline: string | null;
  total_bytes: number | null;
}

export interface IngestState {
  row: WindowRow | null;
  view: BackfillView & { pending: boolean };
  byteLimit: number;
  rateLimit: number;
  admitRemaining: number;
  posts: number;
  hint: string | null;
}

function windowFrom(record: WindowRecord | null): WindowRow | null {
  if (!record) return null;
  return {
    opened_at: record.opened_at,
    closed_at: record.closed_at,
    bytes: Number(record.bytes),
    days: Number(record.days),
    deadline: record.deadline,
    total_bytes: record.total_bytes == null ? null : Number(record.total_bytes),
  };
}

export async function loadIngestState(db: D1Database, settings: Settings, now: Date): Promise<IngestState> {
  const row = windowFrom(await db.prepare("SELECT opened_at, closed_at, bytes, days, deadline, total_bytes FROM ingest_window WHERE id = 1").first<WindowRecord>());
  const quota = await db.prepare("SELECT COUNT(*) AS posts FROM ingest_receipt WHERE window_start = ?").bind(hourWindowStart(now)).first<{ posts: number }>();
  const hint = await db.prepare("SELECT hint FROM export_hint WHERE id = 1").first<{ hint: string | null }>();
  const active = activeLimits(row, settings, now);
  return {
    row,
    view: active.view,
    byteLimit: active.byteLimit,
    rateLimit: active.rateLimit,
    admitRemaining: active.admitRemaining,
    posts: Number(quota?.posts || 0),
    hint: hint?.hint ?? null,
  };
}

export async function putSeries(bucket: R2Bucket, normalized: Normalized) {
  await Promise.all(
    normalized.series.map((series) => {
      if (!isSeriesKey(series.key)) throw new Error("invalid series key");
      return bucket.put(series.key, JSON.stringify(series.body), { httpMetadata: { contentType: "application/json" } });
    }),
  );
}

function sampleStatement(db: D1Database, sample: Sample): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO samples (id, metric, date, start_ts, end_ts, source, qty, qty_min, qty_avg, qty_max, units, label, extra, kind, series_key) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET qty = excluded.qty, qty_min = excluded.qty_min, qty_avg = excluded.qty_avg, qty_max = excluded.qty_max, " +
        "units = excluded.units, label = excluded.label, extra = excluded.extra, end_ts = excluded.end_ts, kind = excluded.kind, series_key = excluded.series_key, start_ts = excluded.start_ts",
    )
    .bind(
      sample.id,
      sample.metric,
      sample.date,
      sample.start_ts,
      sample.end_ts,
      sample.source,
      sample.qty,
      sample.qty_min,
      sample.qty_avg,
      sample.qty_max,
      sample.units,
      sample.label,
      sample.extra ? JSON.stringify(sample.extra) : null,
      sample.kind,
      sample.series_key,
    );
}

function workoutStatement(db: D1Database, workout: Workout): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO workouts (id, name, start_ts, end_ts, date, duration_s, active_kcal, total_kcal, distance_qty, distance_units, hr_min, hr_avg, hr_max, location, source, summary, series_key) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, end_ts = excluded.end_ts, date = excluded.date, duration_s = excluded.duration_s, " +
        "active_kcal = excluded.active_kcal, total_kcal = excluded.total_kcal, distance_qty = excluded.distance_qty, distance_units = excluded.distance_units, " +
        "hr_min = excluded.hr_min, hr_avg = excluded.hr_avg, hr_max = excluded.hr_max, location = excluded.location, source = excluded.source, summary = excluded.summary, series_key = excluded.series_key",
    )
    .bind(
      workout.id,
      workout.name,
      workout.start_ts,
      workout.end_ts,
      workout.date,
      workout.duration_s,
      workout.active_kcal,
      workout.total_kcal,
      workout.distance_qty,
      workout.distance_units,
      workout.hr_min,
      workout.hr_avg,
      workout.hr_max,
      workout.location,
      workout.source,
      workout.summary ? JSON.stringify(workout.summary) : null,
      workout.series_key,
    );
}

function eventStatement(db: D1Database, event: HealthEvent): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO events (id, kind, subtype, start_ts, end_ts, date, source, payload, series_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET subtype = excluded.subtype, end_ts = excluded.end_ts, date = excluded.date, source = excluded.source, payload = excluded.payload, series_key = excluded.series_key",
    )
    .bind(event.id, event.kind, event.subtype, event.start_ts, event.end_ts, event.date, event.source, JSON.stringify(event.payload), event.series_key);
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += BATCH) {
    const slice = statements.slice(index, index + BATCH);
    if (slice.length) await db.batch(slice);
  }
}

export interface SaveOptions {
  normalized: Normalized;
  bytes: number;
  charge: boolean;
  close: boolean;
  countPost: boolean;
  hint: string | null | undefined;
  now: Date;
  settings: Settings;
  state: IngestState;
}

export type SaveResult = { ok: true; state: IngestState } | { ok: false; reason: "rate_limited" | "over_budget"; state: IngestState };

async function receiptFor(normalized: Normalized, close: boolean): Promise<string> {
  const ids = [
    ...normalized.samples.map((row) => `s:${row.id}`),
    ...normalized.workouts.map((row) => `w:${row.id}`),
    ...normalized.events.map((row) => `e:${row.id}`),
  ].sort();
  if (!ids.length) return close ? "close" : "empty";
  return recordId(ids);
}

/**
 * Record one Health Auto Export post. The receipt insert is the gate for the
 * hourly cap and the import byte total, so a retry of the same records does
 * not count again and two first posts cannot both insert the window row.
 */
async function claimPost(db: D1Database, options: SaveOptions, receipt: string): Promise<"claimed" | "retry" | "rate_limited" | "over_budget"> {
  const nowIso = options.now.toISOString();
  const windowStart = hourWindowStart(options.now);
  const openedAt = options.state.row?.opened_at || nowIso;
  const deadline = options.state.row?.deadline || backfillClosesAt(openedAt, options.settings.backfill.hours);
  const total = options.state.row?.total_bytes ?? options.settings.backfill.totalBytes;
  const addBytes = options.charge ? options.bytes : 0;
  const addDays = options.charge ? distinctDates(options.normalized).length : 0;
  const closedAt = options.close ? nowIso : null;
  const rateLimit = options.countPost ? options.state.rateLimit : 0;
  const chargeFlag = options.charge ? 1 : 0;
  const claimed = await db
    .prepare(
      "INSERT INTO ingest_receipt (id, window_start, bytes) " +
        "SELECT ?, ?, ? " +
        "WHERE (? = 0 OR (SELECT COUNT(*) FROM ingest_receipt WHERE window_start = ?) < ?) " +
        "AND (? = 0 OR COALESCE((SELECT bytes FROM ingest_window WHERE id = 1), 0) + ? <= ?) " +
        "ON CONFLICT(id) DO NOTHING RETURNING id",
    )
    .bind(receipt, windowStart, addBytes, rateLimit, windowStart, rateLimit, chargeFlag, addBytes, total)
    .first<{ id: string }>();
  if (claimed?.id) {
    if (options.charge || options.close) {
      await db
        .prepare(
          "INSERT INTO ingest_window (id, opened_at, closed_at, bytes, days, deadline, total_bytes) VALUES (1, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET bytes = ingest_window.bytes + excluded.bytes, days = ingest_window.days + excluded.days, " +
            "closed_at = COALESCE(excluded.closed_at, ingest_window.closed_at)",
        )
        .bind(openedAt, closedAt, addBytes, addDays, deadline, total)
        .run();
    }
    return "claimed";
  }
  const existing = await db.prepare("SELECT id FROM ingest_receipt WHERE id = ?").bind(receipt).first<{ id: string }>();
  if (existing) return "retry";
  const posts = await db.prepare("SELECT COUNT(*) AS posts FROM ingest_receipt WHERE window_start = ?").bind(windowStart).first<{ posts: number }>();
  if (rateLimit > 0 && Number(posts?.posts || 0) >= rateLimit) return "rate_limited";
  return "over_budget";
}

/** Upsert records and, for Health Auto Export, update the import window. */
export async function saveIngest(db: D1Database, options: SaveOptions): Promise<SaveResult> {
  if (options.countPost || options.charge || options.close) {
    const claim = await claimPost(db, options, await receiptFor(options.normalized, options.close));
    if (claim === "rate_limited" || claim === "over_budget") {
      return { ok: false, reason: claim, state: await loadIngestState(db, options.settings, options.now) };
    }
  }
  const statements: D1PreparedStatement[] = [];
  if (options.hint !== undefined) {
    statements.push(db.prepare("INSERT INTO export_hint (id, hint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hint = excluded.hint").bind(options.hint));
  }
  for (const sample of options.normalized.samples) statements.push(sampleStatement(db, sample));
  for (const workout of options.normalized.workouts) statements.push(workoutStatement(db, workout));
  for (const event of options.normalized.events) statements.push(eventStatement(db, event));
  await runBatches(db, statements);
  return { ok: true, state: await loadIngestState(db, options.settings, options.now) };
}

export interface SampleRow {
  metric: string;
  date: string;
  start_ts: string;
  end_ts: string | null;
  source: string;
  qty: number | null;
  qty_min: number | null;
  qty_avg: number | null;
  qty_max: number | null;
  units: string | null;
  label: string | null;
  extra: string | null;
  kind: MetricKind;
  series_key: string | null;
}

export async function samplesForDay(db: D1Database, date: string): Promise<SampleRow[]> {
  const result = await db
    .prepare("SELECT metric, date, start_ts, end_ts, source, qty, qty_min, qty_avg, qty_max, units, label, extra, kind, series_key FROM samples WHERE date = ?")
    .bind(date)
    .all<SampleRow>();
  return result.results;
}

export async function workoutsForDay(db: D1Database, date: string): Promise<Workout[]> {
  const result = await db
    .prepare(
      "SELECT id, name, start_ts, end_ts, date, duration_s, active_kcal, total_kcal, distance_qty, distance_units, hr_min, hr_avg, hr_max, location, source, summary, series_key FROM workouts WHERE date = ? ORDER BY start_ts",
    )
    .bind(date)
    .all<Workout & { summary: string | null }>();
  return result.results.map(parseWorkout);
}

function parseWorkout(row: Workout & { summary: string | null }): Workout {
  return { ...row, summary: row.summary ? (JSON.parse(row.summary) as Record<string, unknown>) : null };
}

export async function readHint(db: D1Database): Promise<string | null> {
  const hint = await db.prepare("SELECT hint FROM export_hint WHERE id = 1").first<{ hint: string | null }>();
  return hint?.hint ?? null;
}

export async function listMetrics(db: D1Database): Promise<{ metric: string; kind: MetricKind; days: number }[]> {
  const result = await db
    .prepare("SELECT metric, kind, COUNT(DISTINCT date) AS days FROM samples GROUP BY metric, kind ORDER BY metric")
    .all<{ metric: string; kind: MetricKind; days: number }>();
  return result.results;
}

const LIVE_SAMPLE =
  "NOT (IFNULL(json_extract(COALESCE(extra, '{}'), '$.apple'), 0) = 1 AND EXISTS (" +
  "SELECT 1 FROM samples AS live WHERE live.metric = samples.metric AND live.date = samples.date " +
  "AND IFNULL(json_extract(live.extra, '$.apple'), 0) != 1))";

export async function metricRollup(db: D1Database, metric: string, start: string, end: string, limit: number) {
  const where = `metric = ? AND date >= ? AND date <= ? AND ${LIVE_SAMPLE}`;
  const kindRow = await db.prepare(`SELECT kind FROM samples WHERE ${where} ORDER BY date, start_ts LIMIT 1`).bind(metric, start, end).first<{ kind: MetricKind }>();
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT date FROM samples WHERE ${where} GROUP BY date)`)
    .bind(metric, start, end)
    .first<{ n: number }>();
  const days = Number(count?.n || 0);
  const truncated = days > limit;
  if (!kindRow) return { kind: "quantity" as const, truncated: false, rows: [] as unknown[] };
  if (kindRow.kind === "sleep") {
    const result = await db
      .prepare(
        `SELECT metric, date, start_ts, end_ts, source, qty, qty_min, qty_avg, qty_max, units, label, extra, kind, series_key FROM samples WHERE ${where} ORDER BY date, start_ts LIMIT 10001`,
      )
      .bind(metric, start, end)
      .all<SampleRow>();
    const rolled = rollupMetric(result.results, limit);
    return { kind: rolled.kind, truncated: truncated || result.results.length > 10_000, rows: rolled.rows };
  }
  const capped = Math.min(limit, 500);
  if (kindRow.kind === "min_avg_max") {
    const result = await db
      .prepare(
        `SELECT date, MIN(COALESCE(qty_min, qty)) AS min, AVG(COALESCE(qty_avg, qty)) AS avg, MAX(COALESCE(qty_max, qty)) AS max, MAX(units) AS units FROM samples WHERE ${where} GROUP BY date ORDER BY date LIMIT ?`,
      )
      .bind(metric, start, end, capped)
      .all<{ date: string; min: number | null; avg: number | null; max: number | null; units: string | null }>();
    return { kind: kindRow.kind, truncated, rows: result.results };
  }
  if (kindRow.kind === "latest") {
    const result = await db
      .prepare(
        `SELECT date, qty, units, start_ts FROM (SELECT date, qty, units, start_ts, ROW_NUMBER() OVER (PARTITION BY date ORDER BY start_ts DESC) AS rn FROM samples WHERE ${where}) ranked WHERE rn = 1 ORDER BY date LIMIT ?`,
      )
      .bind(metric, start, end, capped)
      .all<{ date: string; qty: number | null; units: string | null; start_ts: string }>();
    return { kind: kindRow.kind, truncated, rows: result.results };
  }
  if (kindRow.kind === "blood_pressure") {
    const result = await db
      .prepare(
        `SELECT date, AVG(COALESCE(qty_max, qty)) AS systolic, AVG(qty_min) AS diastolic, MAX(COALESCE(units, 'mmHg')) AS units FROM samples WHERE ${where} GROUP BY date ORDER BY date LIMIT ?`,
      )
      .bind(metric, start, end, capped)
      .all<{ date: string; systolic: number | null; diastolic: number | null; units: string | null }>();
    return { kind: kindRow.kind, truncated, rows: result.results };
  }
  const result = await db
    .prepare(`SELECT date, SUM(COALESCE(qty, 0)) AS qty, MAX(units) AS units FROM samples WHERE ${where} GROUP BY date ORDER BY date LIMIT ?`)
    .bind(metric, start, end, capped)
    .all<{ date: string; qty: number; units: string | null }>();
  return { kind: kindRow.kind, truncated, rows: result.results };
}

export async function workoutsInRange(db: D1Database, start: string, end: string, limit: number): Promise<Workout[]> {
  const result = await db
    .prepare(
      "SELECT id, name, start_ts, end_ts, date, duration_s, active_kcal, total_kcal, distance_qty, distance_units, hr_min, hr_avg, hr_max, location, source, summary, series_key FROM workouts WHERE date >= ? AND date <= ? ORDER BY start_ts LIMIT ?",
    )
    .bind(start, end, limit)
    .all<Workout & { summary: string | null }>();
  return result.results.map(parseWorkout);
}

export async function eventsInRange(db: D1Database, kind: EventKind, start: string, end: string, limit: number): Promise<HealthEvent[]> {
  const result = await db
    .prepare("SELECT id, kind, subtype, start_ts, end_ts, date, source, payload, series_key FROM events WHERE kind = ? AND date >= ? AND date <= ? ORDER BY start_ts LIMIT ?")
    .bind(kind, start, end, limit)
    .all<HealthEvent & { payload: string }>();
  return result.results.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

export async function readSeries(bucket: R2Bucket, key: string): Promise<unknown | null> {
  if (!isSeriesKey(key)) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  return JSON.parse(await object.text());
}
