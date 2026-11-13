import { SUMMARY_METRICS } from "./catalog.js";
import type { SampleRow } from "./storage.js";
import type { Workout } from "./types.js";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export interface DailySummary {
  date: string;
  dietary_kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  active_kcal: number | null;
  basal_kcal: number | null;
  steps: number | null;
  weight: { value: number; units: string | null } | null;
  body_fat_pct: number | null;
  sleep: {
    total_hr: number | null;
    asleep_hr: number | null;
    core_hr: number | null;
    deep_hr: number | null;
    rem_hr: number | null;
    awake_hr: number | null;
    in_bed_hr: number | null;
    start: string | null;
    end: string | null;
  } | null;
  workouts: { name: string; start: string; duration_min: number | null; kcal: number | null }[];
  export_hint?: string;
}

function appleOwned(extra: string | null): boolean {
  if (!extra) return false;
  try {
    return (JSON.parse(extra) as { apple?: unknown }).apple === true;
  } catch {
    return false;
  }
}

/** Health Auto Export samples replace an Apple daily total for the same metric and day. */
export function preferHealthAutoExport(samples: SampleRow[]): SampleRow[] {
  const live = new Set<string>();
  for (const sample of samples) {
    if (!appleOwned(sample.extra)) live.add(`${sample.metric}\0${sample.date}`);
  }
  if (!live.size) return samples;
  return samples.filter((sample) => !appleOwned(sample.extra) || !live.has(`${sample.metric}\0${sample.date}`));
}

function sleepFrom(samples: SampleRow[]): DailySummary["sleep"] {
  const rows = samples.filter((sample) => sample.metric === "sleep_analysis");
  if (!rows.length) return null;
  const segments = rows.filter((sample) => sample.label);
  if (segments.length) {
    const hours = (label: string) => segments.filter((sample) => sample.label === label).reduce((sum, sample) => sum + (sample.qty || 0), 0);
    const asleep = hours("Asleep");
    const core = hours("Core");
    const deep = hours("Deep");
    const rem = hours("REM");
    const starts = segments.map((sample) => sample.start_ts).sort();
    const ends = segments.map((sample) => sample.end_ts || sample.start_ts).sort();
    return {
      total_hr: round1(asleep + core + deep + rem),
      asleep_hr: round1(asleep),
      core_hr: round1(core),
      deep_hr: round1(deep),
      rem_hr: round1(rem),
      awake_hr: round1(hours("Awake")),
      in_bed_hr: round1(hours("In Bed")),
      start: starts[0] || null,
      end: ends[ends.length - 1] || null,
    };
  }
  const summary = [...rows].sort((a, b) => a.start_ts < b.start_ts ? 1 : -1)[0];
  const extra = summary.extra ? (JSON.parse(summary.extra) as Record<string, unknown>) : {};
  return {
    total_hr: asNumber(extra.totalSleep) ?? asNumber(summary.qty),
    asleep_hr: asNumber(extra.asleep),
    core_hr: asNumber(extra.core),
    deep_hr: asNumber(extra.deep),
    rem_hr: asNumber(extra.rem),
    awake_hr: asNumber(extra.awake),
    in_bed_hr: asNumber(extra.inBed),
    start: typeof extra.sleepStart === "string" ? extra.sleepStart : summary.start_ts,
    end: typeof extra.sleepEnd === "string" ? extra.sleepEnd : summary.end_ts,
  };
}

/** One calendar day in the shape GET /summary and get_daily_summary share. */
export function summarizeDay(date: string, samples: SampleRow[], workouts: Workout[], hint: string | null): DailySummary {
  samples = preferHealthAutoExport(samples);
  const out: DailySummary = {
    date,
    dietary_kcal: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    active_kcal: null,
    basal_kcal: null,
    steps: null,
    weight: null,
    body_fat_pct: null,
    sleep: sleepFrom(samples),
    workouts: workouts
      .map((workout) => ({
        name: workout.name,
        start: workout.start_ts,
        duration_min: workout.duration_s == null ? null : Math.round(workout.duration_s / 6) / 10,
        kcal: workout.active_kcal == null ? null : Math.round(workout.active_kcal),
      }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
  };
  const sums = new Map<string, number>();
  const latest = new Map<string, { qty: number; ts: string; units: string | null }>();
  for (const sample of samples) {
    if (sample.qty == null) continue;
    if (Object.hasOwn(SUMMARY_METRICS, sample.metric)) sums.set(sample.metric, (sums.get(sample.metric) || 0) + sample.qty);
    if (sample.metric === "weight_body_mass" || sample.metric === "body_mass" || sample.metric === "weight" || sample.metric === "body_fat_percentage") {
      const prev = latest.get(sample.metric);
      if (!prev || sample.start_ts > prev.ts) latest.set(sample.metric, { qty: sample.qty, ts: sample.start_ts, units: sample.units });
    }
  }
  for (const [metric, field] of Object.entries(SUMMARY_METRICS)) {
    if (!sums.has(metric)) continue;
    const value = round1(sums.get(metric) || 0);
    if (field === "steps") out.steps = Math.round(value);
    else out[field] = value;
  }
  const weight = latest.get("weight_body_mass") || latest.get("body_mass") || latest.get("weight");
  if (weight) out.weight = { value: round1(weight.qty), units: weight.units };
  const fat = latest.get("body_fat_percentage");
  if (fat) out.body_fat_pct = round1(fat.qty <= 1 ? fat.qty * 100 : fat.qty);
  if (hint) out.export_hint = hint;
  return out;
}

export function rollupMetric(rows: SampleRow[], limit = 500) {
  rows = preferHealthAutoExport(rows);
  const kind = rows[0]?.kind || "quantity";
  const byDate = new Map<string, SampleRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.date);
    if (list) list.push(row);
    else byDate.set(row.date, [row]);
  }
  const dates = [...byDate.keys()].sort();
  const truncated = dates.length > limit;
  const selected = dates.slice(0, limit);
  const rolled = selected.map((date) => {
    const group = byDate.get(date) || [];
    const units = group.find((row) => row.units)?.units ?? null;
    if (group[0]?.kind === "min_avg_max" || kind === "min_avg_max") {
      const mins = group.map((row) => row.qty_min ?? row.qty).filter((value): value is number => value != null);
      const avgs = group.map((row) => row.qty_avg ?? row.qty).filter((value): value is number => value != null);
      const maxes = group.map((row) => row.qty_max ?? row.qty).filter((value): value is number => value != null);
      return {
        date,
        min: mins.length ? Math.min(...mins) : null,
        avg: avgs.length ? avgs.reduce((sum, value) => sum + value, 0) / avgs.length : null,
        max: maxes.length ? Math.max(...maxes) : null,
        units,
      };
    }
    if (group[0]?.kind === "latest" || kind === "latest") {
      const last = [...group].sort((a, b) => (a.start_ts < b.start_ts ? 1 : -1))[0];
      return { date, qty: last?.qty ?? null, units: last?.units ?? null, start_ts: last?.start_ts ?? null };
    }
    if (group[0]?.kind === "blood_pressure" || kind === "blood_pressure") {
      const systolic = group.map((row) => row.qty_max ?? row.qty).filter((value): value is number => value != null);
      const diastolic = group.map((row) => row.qty_min).filter((value): value is number => value != null);
      return {
        date,
        systolic: systolic.length ? systolic.reduce((sum, value) => sum + value, 0) / systolic.length : null,
        diastolic: diastolic.length ? diastolic.reduce((sum, value) => sum + value, 0) / diastolic.length : null,
        units: units || "mmHg",
      };
    }
    if (group[0]?.kind === "sleep" || kind === "sleep") {
      const day = sleepFrom(group);
      return { date, ...day };
    }
    const qty = group.reduce((sum, row) => sum + (row.qty || 0), 0);
    return { date, qty, units };
  });
  return { kind: rows[0]?.kind || kind, truncated, rows: rolled };
}
