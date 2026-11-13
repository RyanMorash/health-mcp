import { isSeriesKey } from "./id.js";
import {
  activeLimits,
  backfillClosesAt,
  type BackfillView,
  distinctDates,
  hourWindowStart,
  type Settings,
  type WindowRow,
} from "./limits.js";
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
  const quota = await db.prepare("SELECT posts FROM ingest_quota WHERE window_start = ?").bind(hourWindowStart(now)).first<{ posts: number }>();
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

/** Upsert records and, for Health Auto Export, update the import window and quota. */
export async function saveIngest(db: D1Database, options: SaveOptions): Promise<IngestState> {
  const statements: D1PreparedStatement[] = [];
  const nowIso = options.now.toISOString();
  if (options.countPost && options.state.rateLimit > 0) {
    statements.push(
      db
        .prepare("INSERT INTO ingest_quota (window_start, posts) VALUES (?, 1) ON CONFLICT(window_start) DO UPDATE SET posts = posts + 1")
        .bind(hourWindowStart(options.now)),
    );
  }
  if (options.charge || options.close) {
    const openedAt = options.state.row?.opened_at || nowIso;
    const deadline = options.state.row?.deadline || backfillClosesAt(openedAt, options.settings.backfill.hours);
    const total = options.state.row?.total_bytes ?? options.settings.backfill.totalBytes;
    const addBytes = options.charge ? options.bytes : 0;
    const addDays = options.charge ? distinctDates(options.normalized).length : 0;
    const closedAt = options.close ? nowIso : options.state.row?.closed_at || null;
    if (!options.state.row) {
      statements.push(
        db
          .prepare("INSERT INTO ingest_window (id, opened_at, closed_at, bytes, days, deadline, total_bytes) VALUES (1, ?, ?, ?, ?, ?, ?)")
          .bind(openedAt, closedAt, addBytes, addDays, deadline, total),
      );
    } else {
      statements.push(
        db
          .prepare("UPDATE ingest_window SET bytes = bytes + ?, days = days + ?, closed_at = COALESCE(?, closed_at) WHERE id = 1")
          .bind(addBytes, addDays, options.close ? nowIso : null),
      );
    }
  }
  if (options.hint !== undefined) {
    statements.push(
      db.prepare("INSERT INTO export_hint (id, hint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hint = excluded.hint").bind(options.hint),
    );
  }
  for (const sample of options.normalized.samples) statements.push(sampleStatement(db, sample));
  for (const workout of options.normalized.workouts) statements.push(workoutStatement(db, workout));
  for (const event of options.normalized.events) statements.push(eventStatement(db, event));
  await runBatches(db, statements);
  return loadIngestState(db, options.settings, options.now);
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

export async function metricRows(db: D1Database, metric: string, start: string, end: string): Promise<SampleRow[]> {
  const result = await db
    .prepare(
      "SELECT metric, date, start_ts, end_ts, source, qty, qty_min, qty_avg, qty_max, units, label, extra, kind, series_key FROM samples WHERE metric = ? AND date >= ? AND date <= ? ORDER BY date, start_ts LIMIT 5000",
    )
    .bind(metric, start, end)
    .all<SampleRow>();
  return result.results;
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
