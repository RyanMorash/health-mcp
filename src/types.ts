export type MetricKind =
  | "sum"
  | "latest"
  | "min_avg_max"
  | "blood_pressure"
  | "sleep"
  | "duration_label"
  | "category_count"
  | "quantity";

export type EventKind =
  | "symptom"
  | "cycle"
  | "medication"
  | "state_of_mind"
  | "ecg"
  | "heart_rate_notification"
  | "record";

export interface Sample {
  id: string;
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
  extra: Record<string, unknown> | null;
  kind: MetricKind;
  series_key: string | null;
}

export interface Workout {
  id: string;
  name: string;
  start_ts: string;
  end_ts: string | null;
  date: string;
  duration_s: number | null;
  active_kcal: number | null;
  total_kcal: number | null;
  distance_qty: number | null;
  distance_units: string | null;
  hr_min: number | null;
  hr_avg: number | null;
  hr_max: number | null;
  location: string | null;
  source: string | null;
  summary: Record<string, unknown> | null;
  series_key: string | null;
}

export interface HealthEvent {
  id: string;
  kind: EventKind;
  subtype: string | null;
  start_ts: string;
  end_ts: string | null;
  date: string;
  source: string | null;
  payload: Record<string, unknown>;
  series_key: string | null;
}

export interface SeriesObject {
  key: string;
  body: unknown;
}

export interface Normalized {
  samples: Sample[];
  workouts: Workout[];
  events: HealthEvent[];
  series: SeriesObject[];
}

export function emptyNormalized(): Normalized {
  return { samples: [], workouts: [], events: [], series: [] };
}
