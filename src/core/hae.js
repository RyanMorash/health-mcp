import { localDate } from "./dates.js";
import { ENERGY_METRICS } from "./metrics.js";

/** Top-level arrays in a Health Auto Export Version 2 JSON document. */
export const HAE_ARRAYS = [
  "metrics",
  "workouts",
  "symptoms",
  "ecg",
  "heartRateNotifications",
  "stateOfMind",
  "cycleTracking",
  "medications",
];

const RECORD_KINDS = {
  symptoms: "symptoms",
  ecg: "ecg",
  heartRateNotifications: "heart_rate_notifications",
  stateOfMind: "state_of_mind",
  cycleTracking: "cycle_tracking",
  medications: "medications",
};

const SERIES_KEYS = [
  "heartRateData",
  "heartRateRecovery",
  "route",
  "activeEnergy",
  "basalEnergy",
  "stepCount",
  "cyclingCadence",
  "cyclingDistance",
  "cyclingPower",
  "cyclingSpeed",
  "swimDistance",
  "swimStroke",
  "walkingAndRunningDistance",
  "events",
  "segments",
  "laps",
  "activities",
  "splits",
  "voltageMeasurements",
];

/** Bound parameter stays under the size used for other JSON upserts. */
const DETAIL_LIMIT = 48_000;
const EXTRA_LIMIT = 12_000;
const RECORD_LIMIT = 48_000;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value.qty === "number" && Number.isFinite(value.qty)) return value.qty;
  return null;
}

function toKcal(qty, units) {
  return units && /^kj$/i.test(units) ? qty / 4.184 : qty;
}

export function sourceName(source) {
  if (source == null || source === "") return null;
  if (typeof source === "string") return source;
  if (isPlainObject(source)) return source.name || source.identifier || null;
  return String(source);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function hashId(value) {
  const encoded = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  let hex = "";
  for (const byte of new Uint8Array(digest).subarray(0, 16)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function omit(object, keys) {
  const skip = new Set(keys);
  const extra = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (skip.has(key) || value == null) continue;
    extra[key] = value;
  }
  return extra;
}

function fitJson(value, limit) {
  const text = JSON.stringify(value);
  if (text.length <= limit) return text;
  return null;
}

function shrinkWorkout(detail) {
  const copy = { ...detail };
  let text = fitJson(copy, DETAIL_LIMIT);
  if (text) return text;
  for (const key of SERIES_KEYS) {
    if (!Array.isArray(copy[key]) || copy[key].length === 0) continue;
    const full = copy[key].length;
    copy[key] = copy[key].slice(0, 20);
    copy[`${key}Count`] = full;
    copy.truncated = true;
    text = fitJson(copy, DETAIL_LIMIT);
    if (text) return text;
    delete copy[key];
  }
  copy.truncated = true;
  text = fitJson(copy, DETAIL_LIMIT);
  if (text) return text;
  return JSON.stringify({ truncated: true, name: detail.name || null });
}

function shrinkExtra(extra) {
  const text = fitJson(extra, EXTRA_LIMIT);
  if (text) return text;
  return JSON.stringify({ truncated: true, keys: Object.keys(extra) });
}

function shrinkRecord(record) {
  const text = fitJson(record, RECORD_LIMIT);
  if (text) return text;
  if (Array.isArray(record.voltageMeasurements)) {
    const count = record.numberOfVoltageMeasurements || record.voltageMeasurements.length;
    const copy = { ...record, voltageCount: count, voltageTruncated: true };
    copy.voltageMeasurements = record.voltageMeasurements.slice(0, 40);
    const shorter = fitJson(copy, RECORD_LIMIT);
    if (shorter) return shorter;
    delete copy.voltageMeasurements;
    return fitJson(copy, RECORD_LIMIT) || JSON.stringify({ voltageTruncated: true, voltageCount: count });
  }
  const copy = { ...record, truncated: true };
  for (const key of SERIES_KEYS) delete copy[key];
  return fitJson(copy, RECORD_LIMIT) || JSON.stringify({ truncated: true });
}

function timestamp(sample) {
  return sample?.date || sample?.start || sample?.startDate || sample?.sleepStart || null;
}

/** Health Auto Export uses 00:00:00 for an all-day summary point. */
export function isDayBoundary(ts) {
  return /(?:T|\s)00:00:00(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2})?$/.test(String(ts || ""));
}

/**
 * A lone midnight sample is an all-day total. Midnight is a normal reading
 * when that metric already has other samples on the same day.
 */
export function markDayTotals(samples) {
  const counts = new Map();
  for (const sample of samples || []) {
    const key = `${sample.metric}\0${sample.date}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const sample of samples || []) {
    if (sample.grain !== "reading") continue;
    if (counts.get(`${sample.metric}\0${sample.date}`) !== 1) continue;
    if (isDayBoundary(sample.ts)) sample.grain = "day";
  }
  return samples;
}

/**
 * One metric reading, plus a daily point when the common qty/Avg loop would
 * have skipped it (sleep summaries, blood pressure, sexual activity).
 */
export function readingFromMetric(metric, sample, timeZone) {
  if (!isPlainObject(metric) || !isPlainObject(sample)) return null;
  const name = String(metric.name || "").toLowerCase();
  if (!name) return null;
  const ts = timestamp(sample);
  const date = localDate(ts, timeZone);
  if (!ts || !date) return null;
  let units = metric.units || null;
  const minQty = num(sample.Min);
  const maxQty = num(sample.Max);
  const avgQty = num(sample.Avg ?? sample.avg);
  let qty = num(sample.qty);
  if (qty == null && avgQty != null) qty = avgQty;
  const bucket = sample.qty == null && (minQty != null || avgQty != null || maxQty != null);
  let grain = bucket ? "bucket" : "reading";
  const extra = omit(sample, [
    "qty", "date", "start", "end", "startDate", "endDate", "source", "Min", "Avg", "Max", "avg", "min", "max", "value", "units",
  ]);

  if (name === "sleep_analysis" && sample.totalSleep != null) {
    qty = num(sample.totalSleep);
    grain = "day";
    units = units || "hr";
  } else if (name === "blood_pressure" && (sample.systolic != null || sample.diastolic != null)) {
    qty = num(sample.systolic);
    extra.diastolic = num(sample.diastolic);
    extra.systolic = num(sample.systolic);
  } else if (name === "sexual_activity") {
    const unspecified = num(sample.Unspecified) || 0;
    const used = num(sample["Protection Used"]) || 0;
    const unused = num(sample["Protection Not Used"]) || 0;
    if (sample.Unspecified != null || sample["Protection Used"] != null || sample["Protection Not Used"] != null) {
      qty = unspecified + used + unused;
      grain = "day";
      extra.unspecified = unspecified;
      extra.protection_used = used;
      extra.protection_not_used = unused;
    }
  }

  if (qty != null && ENERGY_METRICS.has(name)) {
    qty = toKcal(qty, units);
    units = "kcal";
  }

  const row = {
    metric: name,
    ts: String(ts),
    date,
    end_ts: sample.end || sample.endDate || null,
    qty,
    min_qty: minQty,
    max_qty: maxQty,
    avg_qty: avgQty,
    units,
    source: sourceName(sample.source),
    value: typeof sample.value === "string" ? sample.value : null,
    grain,
    extra: Object.keys(extra).length ? shrinkExtra(extra) : null,
  };
  return row;
}

export function sleepFromMetric(metric, sample, timeZone) {
  if (!isPlainObject(metric) || String(metric.name || "").toLowerCase() !== "sleep_analysis" || !isPlainObject(sample)) return null;
  const source = sourceName(sample.source);
  if (sample.totalSleep != null || sample.sleepStart || sample.inBedStart) {
    const ts = sample.date || sample.sleepStart || sample.inBedStart;
    const date = localDate(ts, timeZone);
    if (!date) return null;
    return {
      date,
      kind: "summary",
      start_ts: sample.sleepStart || null,
      end_ts: sample.sleepEnd || null,
      in_bed_start: sample.inBedStart || null,
      in_bed_end: sample.inBedEnd || null,
      total_hr: num(sample.totalSleep),
      asleep_hr: num(sample.asleep),
      in_bed_hr: num(sample.inBed),
      core_hr: num(sample.core),
      deep_hr: num(sample.deep),
      rem_hr: num(sample.rem),
      awake_hr: num(sample.awake),
      stage: null,
      source,
      identity: ["sleep", "summary", date, source, sample.sleepStart || null, sample.sleepEnd || null],
    };
  }
  if (sample.value == null && sample.qty == null) return null;
  const start = sample.start || sample.startDate || sample.date;
  const end = sample.end || sample.endDate || null;
  const date = localDate(start, timeZone);
  if (!date) return null;
  return {
    date,
    kind: "segment",
    start_ts: start ? String(start) : null,
    end_ts: end ? String(end) : null,
    in_bed_start: null,
    in_bed_end: null,
    total_hr: num(sample.qty),
    asleep_hr: null,
    in_bed_hr: null,
    core_hr: null,
    deep_hr: null,
    rem_hr: null,
    awake_hr: null,
    stage: typeof sample.value === "string" ? sample.value : null,
    source,
    identity: ["sleep", "segment", start || null, end || null, sample.value || null, source],
  };
}

export function workoutMeta(workout) {
  if (!isPlainObject(workout) || !workout.start) return null;
  const detail = { ...workout };
  delete detail.name;
  delete detail.start;
  delete detail.duration;
  return {
    name: String(workout.name || "Workout"),
    start: String(workout.start),
    end_ts: workout.end ? String(workout.end) : null,
    source: sourceName(workout.source),
    detail: shrinkWorkout(detail),
  };
}

function recordTimestamp(kind, record) {
  if (kind === "medications") return record.start || record.scheduledDate || record.end;
  if (kind === "state_of_mind") return record.start || record.end;
  return record.start || record.date || record.end;
}

function recordName(kind, record) {
  if (kind === "symptoms" || kind === "cycle_tracking") return record.name || null;
  if (kind === "medications") return record.displayText || record.nickname || null;
  if (kind === "heart_rate_notifications") return record.heartNotification || null;
  if (kind === "state_of_mind") return record.kind || null;
  if (kind === "ecg") return record.classification || null;
  return null;
}

function recordIdentity(kind, record, ts) {
  if (kind === "state_of_mind" && record.id) return [kind, record.id];
  if (kind === "symptoms") return [kind, record.start || ts, record.end || null, record.name || null, sourceName(record.source)];
  if (kind === "ecg") return [kind, record.start || ts, sourceName(record.source)];
  if (kind === "heart_rate_notifications") return [kind, record.heartNotification || null, record.start || ts, record.end || null];
  if (kind === "cycle_tracking") return [kind, record.start || ts, record.end || null, record.name || null, record.value || null];
  if (kind === "medications") return [kind, record.start || ts, record.displayText || null, record.scheduledDate || null, record.status || null];
  return [kind, ts, recordName(kind, record)];
}

export function recordsFrom(data, timeZone) {
  const records = [];
  for (const [key, kind] of Object.entries(RECORD_KINDS)) {
    const list = data?.[key];
    if (!Array.isArray(list)) continue;
    for (const record of list) {
      if (!isPlainObject(record)) continue;
      const ts = recordTimestamp(kind, record);
      const date = localDate(ts, timeZone);
      if (!date) continue;
      records.push({
        kind,
        ts: ts ? String(ts) : null,
        date,
        name: recordName(kind, record),
        source: sourceName(record.source),
        payload: shrinkRecord(record),
        identity: recordIdentity(kind, record, ts ? String(ts) : null),
      });
    }
  }
  return records;
}

export function haeData(body) {
  const data = isPlainObject(body?.data) ? body.data : isPlainObject(body) ? body : null;
  return data;
}

/** True when the object has at least one Health Auto Export array. */
export function hasHaeArrays(data) {
  if (!isPlainObject(data)) return false;
  return HAE_ARRAYS.some((key) => Object.hasOwn(data, key));
}

export function haeArrayError(data) {
  if (!isPlainObject(data)) return "invalid_payload";
  if (!hasHaeArrays(data)) return "invalid_payload";
  for (const key of HAE_ARRAYS) {
    if (!Object.hasOwn(data, key)) continue;
    if (!Array.isArray(data[key])) return "invalid_payload";
    for (const item of data[key]) {
      if (!isPlainObject(item)) return "invalid_payload";
      if (key === "metrics" && item.data != null && !Array.isArray(item.data)) return "invalid_payload";
      if (key === "metrics" && Array.isArray(item.data)) {
        for (const sample of item.data) {
          if (!isPlainObject(sample)) return "invalid_payload";
        }
      }
    }
  }
  return null;
}

async function withSig(row, identity, content) {
  const id = await hashId(identity);
  const sig = await hashId([identity, content]);
  return { ...row, id, sig };
}

/** Stable ids so a repeated Health Auto Export post upserts instead of duplicating. */
export async function identifyHealth({ samples = [], sleep = [], records = [], workouts = [], workoutMetaRows = [] } = {}) {
  const sampleRows = [];
  for (const row of samples) {
    const identity = ["sample", row.metric, row.ts, row.end_ts, row.source, row.value, row.grain, row.extra];
    sampleRows.push(await withSig(row, identity, [row.qty, row.min_qty, row.max_qty, row.avg_qty, row.units, row.extra]));
  }
  const sleepRows = [];
  for (const row of sleep) {
    sleepRows.push(await withSig(
      row,
      row.identity,
      [row.total_hr, row.asleep_hr, row.in_bed_hr, row.core_hr, row.deep_hr, row.rem_hr, row.awake_hr, row.stage, row.start_ts, row.end_ts],
    ));
  }
  const recordRows = [];
  for (const row of records) {
    recordRows.push(await withSig(row, row.identity, row.payload));
  }
  const metas = new Map(workoutMetaRows.map((row) => [`${row.name}\0${row.start}`, row]));
  const nextWorkouts = workouts.map((workout) => {
    const meta = metas.get(`${workout.name}\0${workout.start}`);
    if (!meta) return workout;
    return { ...workout, end_ts: meta.end_ts, source: meta.source, detail: meta.detail };
  });
  return { sampleRows, sleepRows, recordRows, workouts: nextWorkouts };
}
