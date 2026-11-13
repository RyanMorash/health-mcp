import { localDate } from "./dates.js";
import { haeArrayError, haeData, markDayTotals, readingFromMetric, recordsFrom, sleepFromMetric, workoutMeta } from "./hae.js";
import { DEFAULT_TIME_ZONE, ENERGY_METRICS } from "./metrics.js";

export { localDate } from "./dates.js";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Null when `body` is a Health Auto Export object. Version 2 may contain
 * metrics, workouts, symptoms, ECG, heart-rate notifications, state of mind,
 * cycle tracking, or medications. A body that is already the `data` object
 * is accepted too.
 */
export function payloadError(body) {
  if (!isPlainObject(body)) return "invalid_payload";
  const data = Object.hasOwn(body, "data") ? body.data : body;
  return haeArrayError(data);
}

function toKcal(qty, units) {
  return units && /^kj$/i.test(units) ? qty / 4.184 : qty;
}

function num(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.qty === "number") return value.qty;
  return null;
}

/**
 * Parse a Health Auto Export v2 body (`{ data: { metrics, workouts, ... } }`).
 * A body that is already the `data` object is accepted too.
 * `points` and `workouts` keep the daily-summary shape. `samples`, `sleep`,
 * `records`, and `workoutMetaRows` carry the rest of the document.
 * @param {unknown} body
 * @param {{ timeZone?: string }} [options]
 */
export function parse(body, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const data = haeData(body);
  const points = [];
  const workouts = [];
  const samples = [];
  const sleep = [];
  const workoutMetaRows = [];

  for (const metric of data?.metrics || []) {
    if (!isPlainObject(metric)) continue;
    const name = String(metric.name || "").toLowerCase();
    for (const sample of metric.data || []) {
      if (!isPlainObject(sample)) continue;
      const reading = readingFromMetric(metric, sample, timeZone);
      const night = sleepFromMetric(metric, sample, timeZone);
      if (reading) samples.push(reading);
      if (night) sleep.push(night);
      const ts = sample.date || sample.startDate || sample.start;
      let qty = num(sample.qty ?? sample.Avg ?? sample.avg);
      if (name === "sleep_analysis" && qty == null && sample.totalSleep != null) qty = num(sample.totalSleep);
      if (name === "blood_pressure" && qty == null && sample.systolic != null) qty = num(sample.systolic);
      if (!ts || qty == null || !reading) continue;
      let units = metric.units || null;
      if (ENERGY_METRICS.has(name)) {
        qty = toKcal(qty, units);
        units = "kcal";
      }
      if (name === "sleep_analysis" && sample.totalSleep != null) units = units || "hr";
      points.push({ metric: name, ts: String(ts), date: reading.date, units, qty });
    }
  }

  for (const workout of data?.workouts || []) {
    if (!isPlainObject(workout) || !workout.start) continue;
    let duration = num(workout.duration);
    if (duration == null && workout.end) {
      duration = (new Date(workout.end) - new Date(workout.start)) / 1000;
    }
    const energy = workout.activeEnergyBurned ?? workout.activeEnergy ?? workout.totalEnergy;
    let kcal = Array.isArray(energy)
      ? energy.reduce((sum, sample) => sum + (num(sample) || 0), 0)
      : num(energy);
    if (kcal != null && energy?.units) kcal = toKcal(kcal, energy.units);
    workouts.push({
      name: String(workout.name || "Workout"),
      start: String(workout.start),
      date: localDate(workout.start, timeZone),
      duration_min: duration == null ? null : Math.round(duration / 6) / 10,
      kcal: kcal == null ? null : Math.round(kcal),
    });
    const meta = workoutMeta(workout);
    if (meta) workoutMetaRows.push(meta);
  }

  return {
    points: points.filter((point) => point.date),
    workouts: workouts.filter((workout) => workout.date),
    samples: markDayTotals(samples.filter((sample) => sample.date)),
    sleep: sleep.filter((row) => row.date),
    records: recordsFrom(data, timeZone),
    workoutMetaRows,
  };
}
