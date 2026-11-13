import { ENERGY_METRICS, kindFor, toKcal } from "../catalog.js";
import { instant, localDate } from "../dates.js";
import { recordId, seriesKey } from "../id.js";
import { emptyNormalized, type EventKind, type HealthEvent, type MetricKind, type Normalized, type Sample, type SeriesObject, type Workout } from "../types.js";

const KNOWN_KEYS = new Set([
  "metrics",
  "workouts",
  "symptoms",
  "cycleTracking",
  "cycle_tracking",
  "medications",
  "stateOfMind",
  "state_of_mind",
  "ecg",
  "heartRateNotifications",
  "heart_rate_notifications",
]);

const EVENT_KEYS: Record<string, EventKind> = {
  symptoms: "symptom",
  cycleTracking: "cycle",
  cycle_tracking: "cycle",
  medications: "medication",
  stateOfMind: "state_of_mind",
  state_of_mind: "state_of_mind",
  ecg: "ecg",
  heartRateNotifications: "heart_rate_notification",
  heart_rate_notifications: "heart_rate_notification",
};

const WORKOUT_SERIES = [
  "route",
  "heartRateData",
  "heartRateRecovery",
  "activeEnergy",
  "basalEnergy",
  "cyclingCadence",
  "cyclingDistance",
  "cyclingPower",
  "cyclingSpeed",
  "swimDistance",
  "swimStroke",
  "walkingAndRunningDistance",
  "stepCount",
  "events",
  "segments",
  "laps",
  "activities",
  "splits",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sourceName(value: unknown): string {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.name === "string") return value.name;
  return "";
}

function qtyOf(value: unknown): { qty: number | null; units: string | null } {
  const direct = num(value);
  if (direct != null) return { qty: direct, units: null };
  if (!isObject(value)) return { qty: null, units: null };
  return { qty: num(value.qty), units: text(value.units) };
}

function stamp(sample: Record<string, unknown>): string | null {
  return text(sample.date) || text(sample.start) || text(sample.startDate) || text(sample.scheduledDate);
}

function blankSample(metric: string, when: string, date: string, source: string, kind: MetricKind): Sample {
  return {
    id: "",
    metric,
    date,
    start_ts: when,
    end_ts: text(null),
    source,
    qty: null,
    qty_min: null,
    qty_avg: null,
    qty_max: null,
    units: null,
    label: null,
    extra: null,
    kind,
    series_key: null,
  };
}

function applyEnergy(sample: Sample, units: string | null): void {
  if (!ENERGY_METRICS.has(sample.metric) || sample.qty == null) return;
  sample.qty = toKcal(sample.qty, units);
  sample.units = "kcal";
}

function readMetricSample(metricName: string, units: string | null, sample: Record<string, unknown>, timeZone: string): Sample | { series: Record<string, unknown>; sample: Sample } | null {
  const when = stamp(sample);
  if (!when) return null;
  const end = text(sample.end) || text(sample.endDate);
  const kind = kindFor(metricName);
  const source = sourceName(sample.source);
  let date = localDate(when, timeZone);
  if (metricName === "sleep_analysis" && end) date = localDate(end, timeZone);
  if (!date) return null;
  const row = blankSample(metricName, when, date, source, kind);
  row.end_ts = end;
  row.units = units;

  if (metricName === "blood_pressure" || num(sample.systolic) != null || num(sample.diastolic) != null) {
    const systolic = num(sample.systolic);
    const diastolic = num(sample.diastolic);
    if (systolic == null && diastolic == null) return null;
    row.kind = "blood_pressure";
    row.metric = metricName === "blood_pressure" ? metricName : "blood_pressure";
    row.qty = systolic;
    row.qty_min = diastolic;
    row.qty_max = systolic;
    row.units = units || "mmHg";
    row.extra = { systolic, diastolic };
    return row;
  }

  if (metricName === "sleep_analysis" && (sample.totalSleep != null || sample.inBed != null) && typeof sample.value !== "string") {
    row.kind = "sleep";
    row.qty = num(sample.totalSleep);
    row.extra = {
      totalSleep: num(sample.totalSleep),
      asleep: num(sample.asleep),
      core: num(sample.core),
      deep: num(sample.deep),
      rem: num(sample.rem),
      awake: num(sample.awake),
      inBed: num(sample.inBed),
      sleepStart: text(sample.sleepStart),
      sleepEnd: text(sample.sleepEnd),
      inBedStart: text(sample.inBedStart),
      inBedEnd: text(sample.inBedEnd),
    };
    if (text(sample.sleepEnd)) row.end_ts = text(sample.sleepEnd);
    return row;
  }

  if (metricName === "sleep_analysis" && typeof sample.value === "string") {
    row.kind = "sleep";
    row.label = sample.value;
    row.qty = num(sample.qty);
    row.units = units || "hr";
    return row;
  }

  if (sample["Protection Used"] != null || sample["Protection Not Used"] != null || sample.Unspecified != null) {
    const used = num(sample["Protection Used"]) ?? 0;
    const unused = num(sample["Protection Not Used"]) ?? 0;
    const unspecified = num(sample.Unspecified) ?? 0;
    row.kind = "category_count";
    row.metric = metricName || "sexual_activity";
    row.qty = used + unused + unspecified;
    row.extra = { protection_used: used, protection_not_used: unused, unspecified };
    return row;
  }

  const min = num(sample.Min ?? sample.min);
  const avg = num(sample.Avg ?? sample.avg);
  const max = num(sample.Max ?? sample.max);
  if (min != null || avg != null || max != null) {
    row.kind = kind === "quantity" ? "min_avg_max" : kind === "sum" ? "min_avg_max" : kind;
    if (row.kind !== "min_avg_max" && row.kind !== "latest") row.kind = "min_avg_max";
    row.qty_min = min;
    row.qty_avg = avg;
    row.qty_max = max;
    row.qty = avg ?? min ?? max;
    const beats = sample.beats ?? sample.beatToBeat ?? sample.beat_to_beat;
    if (Array.isArray(beats) && beats.length) return { sample: row, series: { beats } };
    return row;
  }

  const qty = num(sample.qty);
  if (qty == null && text(sample.value) == null) {
    const extra = { ...sample };
    delete extra.date;
    delete extra.start;
    delete extra.end;
    delete extra.startDate;
    delete extra.endDate;
    delete extra.source;
    if (!Object.keys(extra).length) return null;
    row.extra = extra;
    return row;
  }

  row.qty = qty;
  row.label = text(sample.value);
  const extra: Record<string, unknown> = {};
  if (text(sample.foodType)) extra.foodType = text(sample.foodType);
  if (text(sample.mealTime)) extra.mealTime = text(sample.mealTime);
  if (text(sample.reason)) extra.reason = text(sample.reason);
  row.extra = Object.keys(extra).length ? extra : null;
  applyEnergy(row, units);
  if (row.kind === "duration_label" && row.qty != null && !row.label) {
    row.label = metricName === "toothbrushing" ? (row.qty >= 120 ? "Completed" : "Incomplete") : row.qty > 20 ? "Completed" : "Incomplete";
  }
  return row;
}

async function identifySample(sample: Sample): Promise<void> {
  const extra = sample.extra || {};
  sample.id = await recordId([
    "sample",
    sample.metric,
    sample.start_ts,
    sample.end_ts,
    sample.source,
    sample.label,
    extra.foodType ?? null,
    extra.mealTime ?? null,
    extra.reason ?? null,
    extra.systolic ?? null,
    extra.diastolic ?? null,
  ]);
}

function heartSummary(value: unknown): { min: number | null; avg: number | null; max: number | null } {
  if (!isObject(value)) return { min: null, avg: null, max: null };
  const read = (part: unknown): number | null => (isObject(part) ? num(part.qty) : num(part));
  return {
    min: read(value.min) ?? num(value.Min),
    avg: read(value.avg) ?? num(value.Avg),
    max: read(value.max) ?? num(value.Max),
  };
}

async function readWorkout(workout: Record<string, unknown>, timeZone: string, series: SeriesObject[]): Promise<Workout | null> {
  const start = text(workout.start) || text(workout.startDate);
  const name = text(workout.name) || "Workout";
  if (!start) return null;
  const date = localDate(start, timeZone);
  if (!date) return null;
  const end = text(workout.end) || text(workout.endDate);
  let duration = num(workout.duration);
  if (duration == null && end) {
    const left = instant(start);
    const right = instant(end);
    if (left != null && right != null) duration = (right - left) / 1000;
  }
  const active = qtyOf(workout.activeEnergyBurned ?? workout.activeEnergy);
  const total = qtyOf(workout.totalEnergy ?? workout.totalEnergyBurned);
  const distance = qtyOf(workout.distance);
  const heart = heartSummary(workout.heartRate);
  const summary: Record<string, unknown> = {};
  for (const key of ["location", "isIndoor", "intensity", "speed", "avgSpeed", "maxSpeed", "elevationUp", "elevationDown", "temperature", "humidity", "lapLength", "strokeStyle", "swolfScore", "salinity", "totalSwimmingStrokeCount", "swimCadence", "stepCadence", "flightsClimbed", "effortScore", "estimatedEffortScore", "metadata"]) {
    if (workout[key] != null && !Array.isArray(workout[key])) summary[key] = workout[key];
  }
  const seriesBody: Record<string, unknown> = {};
  for (const key of WORKOUT_SERIES) {
    if (Array.isArray(workout[key]) && workout[key].length) seriesBody[key] = workout[key];
  }
  let series_key: string | null = null;
  if (Object.keys(seriesBody).length) {
    series_key = await seriesKey(seriesBody);
    series.push({ key: series_key, body: seriesBody });
  }
  const id = text(workout.id) || (await recordId(["workout", name, start, sourceName(workout.source)]));
  return {
    id,
    name,
    start_ts: start,
    end_ts: end,
    date,
    duration_s: duration,
    active_kcal: active.qty == null ? null : toKcal(active.qty, active.units),
    total_kcal: total.qty == null ? null : toKcal(total.qty, total.units),
    distance_qty: distance.qty,
    distance_units: distance.units,
    hr_min: heart.min ?? num(isObject(workout.minHeartRate) ? workout.minHeartRate.qty : workout.minHeartRate),
    hr_avg: heart.avg ?? num(isObject(workout.avgHeartRate) ? workout.avgHeartRate.qty : workout.avgHeartRate),
    hr_max: heart.max ?? num(isObject(workout.maxHeartRate) ? workout.maxHeartRate.qty : workout.maxHeartRate),
    location: text(workout.location),
    source: sourceName(workout.source) || null,
    summary: Object.keys(summary).length ? summary : null,
    series_key,
  };
}

function eventSubtype(kind: EventKind, record: Record<string, unknown>): string | null {
  return (
    text(record.name) ||
    text(record.type) ||
    text(record.symptom) ||
    text(record.kind) ||
    text(record.classification) ||
    text(record.displayText) ||
    text(record.nickname) ||
    kind
  );
}

async function readEvent(kind: EventKind, record: Record<string, unknown>, timeZone: string, series: SeriesObject[]): Promise<HealthEvent | null> {
  const start = stamp(record) || text(record.startDate) || text(record.scheduledDate);
  if (!start) return null;
  const end = text(record.end) || text(record.endDate);
  const date = localDate(end || start, timeZone);
  if (!date) return null;
  const payload = { ...record };
  let series_key: string | null = null;
  const bulky: Record<string, unknown> = {};
  for (const key of ["voltageMeasurements", "heartRateData", "beats", "samples"]) {
    if (Array.isArray(payload[key])) {
      bulky[key] = payload[key];
      delete payload[key];
    }
  }
  if (Object.keys(bulky).length) {
    series_key = await seriesKey(bulky);
    series.push({ key: series_key, body: bulky });
  }
  const subtype = eventSubtype(kind, record);
  const id = text(record.id) || (await recordId(["event", kind, subtype, start, sourceName(record.source), text(record.classification)]));
  return {
    id,
    kind,
    subtype,
    start_ts: start,
    end_ts: end,
    date,
    source: sourceName(record.source) || null,
    payload,
    series_key,
  };
}

export interface ParseResult {
  error: string | null;
  normalized: Normalized;
}

/**
 * Health Auto Export JSON version 2.
 * Accepts `{ data: { metrics, workouts, ... } }` or the bare `data` object.
 * Unknown arrays are kept as `record` events. Unknown metrics are stored.
 */
export async function parseHealthAutoExport(body: unknown, timeZone: string): Promise<ParseResult> {
  if (!isObject(body)) return { error: "invalid_payload", normalized: emptyNormalized() };
  const data = isObject(body.data) ? body.data : body;
  if (!isObject(data)) return { error: "invalid_payload", normalized: emptyNormalized() };
  const keys = Object.keys(data).filter((key) => key !== "backfill");
  if (!keys.length) return { error: "invalid_payload", normalized: emptyNormalized() };
  for (const key of keys) {
    if (KNOWN_KEYS.has(key) && data[key] != null && !Array.isArray(data[key])) return { error: "invalid_payload", normalized: emptyNormalized() };
  }
  const hasArray = keys.some((key) => Array.isArray(data[key]));
  if (!hasArray) return { error: "invalid_payload", normalized: emptyNormalized() };

  const normalized = emptyNormalized();
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  for (const metric of metrics) {
    if (!isObject(metric)) return { error: "invalid_payload", normalized: emptyNormalized() };
    const name = (text(metric.name) || "unknown_metric").toLowerCase();
    const units = text(metric.units);
    const points = Array.isArray(metric.data) ? metric.data : [];
    for (const point of points) {
      if (!isObject(point)) return { error: "invalid_payload", normalized: emptyNormalized() };
      const parsed = readMetricSample(name, units, point, timeZone);
      if (!parsed) continue;
      const sample = "sample" in parsed ? parsed.sample : parsed;
      await identifySample(sample);
      if ("series" in parsed) {
        const key = await seriesKey(parsed.series);
        sample.series_key = key;
        normalized.series.push({ key, body: parsed.series });
      }
      normalized.samples.push(sample);
    }
  }

  const workouts = Array.isArray(data.workouts) ? data.workouts : [];
  for (const workout of workouts) {
    if (!isObject(workout)) return { error: "invalid_payload", normalized: emptyNormalized() };
    const parsed = await readWorkout(workout, timeZone, normalized.series);
    if (parsed) normalized.workouts.push(parsed);
  }

  for (const [key, kind] of Object.entries(EVENT_KEYS)) {
    const rows = data[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isObject(row)) return { error: "invalid_payload", normalized: emptyNormalized() };
      const parsed = await readEvent(kind, row, timeZone, normalized.series);
      if (parsed) normalized.events.push(parsed);
    }
  }

  for (const key of keys) {
    if (KNOWN_KEYS.has(key) || !Array.isArray(data[key])) continue;
    for (const row of data[key] as unknown[]) {
      if (!isObject(row)) continue;
      const parsed = await readEvent("record", { ...row, type: text(row.type) || key }, timeZone, normalized.series);
      if (parsed) {
        parsed.subtype = parsed.subtype || key;
        normalized.events.push(parsed);
      }
    }
  }

  return { error: null, normalized };
}
