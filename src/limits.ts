import { isRealIsoDate, localDate, resolveTimeZone, shiftIsoDate, utcToday } from "./dates.js";
import type { Normalized } from "./types.js";

export const DEFAULT_INGEST_MAX_AGE_DAYS = 1;
export const MAX_INGEST_MAX_AGE_DAYS = 36500;
export const DEFAULT_INGEST_MAX_BODY_BYTES = 1_000_000;
export const MAX_PAYLOAD_BYTES = 10_000_000;
export const DEFAULT_INGEST_RATE_PER_HOUR = 6;
export const DEFAULT_INGEST_BACKFILL_MAX_BYTES = 5_000_000;
export const MAX_INGEST_BACKFILL_MAX_BYTES = 10_000_000;
export const DEFAULT_INGEST_BACKFILL_MAX_PER_HOUR = 60;
export const MAX_INGEST_BACKFILL_MAX_PER_HOUR = 10_000;
export const DEFAULT_INGEST_BACKFILL_MAX_TOTAL_BYTES = 500_000_000;
export const MAX_INGEST_BACKFILL_MAX_TOTAL_BYTES = 5_000_000_000;
export const DEFAULT_INGEST_BACKFILL_HOURS = 72;
export const MAX_INGEST_BACKFILL_HOURS = 24 * 366;
export const DEFAULT_INGEST_MIN_DATE = "2000-01-01";
export const INGEST_MIN_DATE_FLOOR = "1970-01-01";
export const MAX_INGEST_DATES = 366;
export const FUTURE_SKEW_DAYS = 1;
export const STALE_HINT_AT = 50;
export const INITIAL_IMPORT_CLOSED = "The initial import window is closed.";

export interface BackfillLimits {
  maxBytes: number;
  perHour: number;
  totalBytes: number;
  hours: number;
}

export interface Settings {
  token: string;
  timeZone: string;
  maxAgeDays: number;
  maxBodyBytes: number;
  ratePerHour: number;
  backfill: BackfillLimits;
  minDate: string;
  allowedOrigins: string[];
}

function configuredInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value.trim()))) return Number(value.trim());
  return null;
}

function atLeastOne(value: unknown, fallback: number, max: number): number {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function resolveMaxAgeDays(value: unknown): number {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 0) return DEFAULT_INGEST_MAX_AGE_DAYS;
  return Math.min(parsed, MAX_INGEST_MAX_AGE_DAYS);
}

export function resolveMaxBodyBytes(value: unknown): number {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 1) return DEFAULT_INGEST_MAX_BODY_BYTES;
  return Math.min(parsed, MAX_PAYLOAD_BYTES);
}

export function resolveRatePerHour(value: unknown): number {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 0) return DEFAULT_INGEST_RATE_PER_HOUR;
  return parsed;
}

export function resolveMinDate(value: unknown, now = new Date()): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!isRealIsoDate(trimmed)) return DEFAULT_INGEST_MIN_DATE;
  const today = utcToday(now);
  if (trimmed < INGEST_MIN_DATE_FLOOR) return INGEST_MIN_DATE_FLOOR;
  if (isRealIsoDate(today) && trimmed > today) return today;
  return trimmed;
}

export function settingsFromEnv(env: Env, now = new Date()): Settings {
  const origins = String(env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    token: env.HEALTH_INGEST_TOKEN,
    timeZone: resolveTimeZone(env.HEALTH_TIMEZONE),
    maxAgeDays: resolveMaxAgeDays(env.INGEST_MAX_AGE_DAYS),
    maxBodyBytes: resolveMaxBodyBytes(env.INGEST_MAX_BODY_BYTES),
    ratePerHour: resolveRatePerHour(env.INGEST_RATE_LIMIT_PER_HOUR),
    backfill: {
      maxBytes: atLeastOne(env.INGEST_BACKFILL_MAX_BYTES, DEFAULT_INGEST_BACKFILL_MAX_BYTES, MAX_INGEST_BACKFILL_MAX_BYTES),
      perHour: atLeastOne(env.INGEST_BACKFILL_MAX_PER_HOUR, DEFAULT_INGEST_BACKFILL_MAX_PER_HOUR, MAX_INGEST_BACKFILL_MAX_PER_HOUR),
      totalBytes: atLeastOne(env.INGEST_BACKFILL_MAX_TOTAL_BYTES, DEFAULT_INGEST_BACKFILL_MAX_TOTAL_BYTES, MAX_INGEST_BACKFILL_MAX_TOTAL_BYTES),
      hours: atLeastOne(env.INGEST_BACKFILL_HOURS, DEFAULT_INGEST_BACKFILL_HOURS, MAX_INGEST_BACKFILL_HOURS),
    },
    minDate: resolveMinDate(env.INGEST_MIN_DATE, now),
    allowedOrigins: origins,
  };
}

export function byteLabel(maxBytes: number): string {
  if (maxBytes % 1_000_000 === 0) return `${maxBytes / 1_000_000} MB`;
  if (maxBytes >= 1_000_000) return `${(maxBytes / 1_000_000).toFixed(1)} MB`;
  return `${maxBytes} bytes`;
}

export function chunkHint(maxBytes: number): string {
  return `Import history in chunks of ${byteLabel(maxBytes)} or less.`;
}

export function exportHint(maxBytes: number): string {
  return `This export looks misconfigured: it sent too much history or it is posting too often. ${chunkHint(maxBytes)} Follow Recommended export settings in the README.`;
}

export interface WindowRow {
  opened_at: string;
  closed_at: string | null;
  bytes: number;
  days: number;
  deadline: string | null;
  total_bytes: number | null;
}

export interface BackfillView {
  open: boolean;
  closes_at: string | null;
  bytes_remaining: number;
}

export function backfillClosesAt(openedAt: string, hours: number): string {
  const opened = Date.parse(openedAt);
  if (!Number.isFinite(opened)) return new Date(0).toISOString();
  return new Date(opened + hours * 3_600_000).toISOString();
}

export function backfillStatus(row: WindowRow | null, limits: BackfillLimits, now: Date): BackfillView & { pending: boolean } {
  if (!row) return { open: false, closes_at: null, bytes_remaining: 0, pending: true };
  const scheduled = row.deadline || backfillClosesAt(row.opened_at, limits.hours);
  const total = row.total_bytes == null ? limits.totalBytes : Number(row.total_bytes);
  const expired = !(now.getTime() < Date.parse(scheduled));
  const full = Number(row.bytes) >= total;
  const open = row.closed_at == null && !expired && !full;
  return {
    open,
    closes_at: row.closed_at ?? scheduled,
    bytes_remaining: open ? Math.max(0, total - Number(row.bytes)) : 0,
    pending: false,
  };
}

export function activeLimits(row: WindowRow | null, settings: Settings, now: Date) {
  const view = backfillStatus(row, settings.backfill, now);
  const relaxed = view.open || view.pending;
  return {
    view,
    byteLimit: relaxed ? Math.max(settings.maxBodyBytes, settings.backfill.maxBytes) : settings.maxBodyBytes,
    rateLimit: relaxed
      ? settings.ratePerHour === 0
        ? settings.backfill.perHour
        : Math.max(settings.ratePerHour, settings.backfill.perHour)
      : settings.ratePerHour,
    admitRemaining: view.open ? view.bytes_remaining : view.pending ? settings.backfill.totalBytes : 0,
  };
}

export function hourWindowStart(now: Date): number {
  return Math.floor(now.getTime() / 3_600_000) * 3_600_000;
}

export function secondsUntilNextHour(now: Date): number {
  return Math.max(1, Math.ceil((hourWindowStart(now) + 3_600_000 - now.getTime()) / 1000));
}

export function distinctDates(normalized: Normalized): string[] {
  const dates = new Set<string>();
  for (const row of [...normalized.samples, ...normalized.workouts, ...normalized.events]) {
    if (row.date) dates.add(row.date);
  }
  return [...dates].sort();
}

export interface Filtered {
  normalized: Normalized;
  droppedStale: number;
  droppedFuture: number;
  droppedEarly: number;
}

export function filterNormalized(
  normalized: Normalized,
  options: { now: Date; timeZone: string; maxAgeDays: number; keepPast: boolean; minDate: string },
): Filtered {
  const today = localDate(options.now.toISOString(), options.timeZone) || utcToday(options.now);
  const cutoff = options.keepPast ? today : shiftIsoDate(today, -options.maxAgeDays);
  const future = shiftIsoDate(today, FUTURE_SKEW_DAYS);
  const earliest = isRealIsoDate(options.minDate) ? options.minDate : DEFAULT_INGEST_MIN_DATE;
  const kept: Normalized = { samples: [], workouts: [], events: [], series: [] };
  let droppedStale = 0;
  let droppedFuture = 0;
  let droppedEarly = 0;
  const keep = (date: string): boolean => {
    if (date < earliest) {
      droppedEarly += 1;
      return false;
    }
    if (date > future) {
      droppedFuture += 1;
      return false;
    }
    if (!options.keepPast && date < cutoff) {
      droppedStale += 1;
      return false;
    }
    return true;
  };
  for (const sample of normalized.samples) if (keep(sample.date)) kept.samples.push(sample);
  for (const workout of normalized.workouts) if (keep(workout.date)) kept.workouts.push(workout);
  for (const event of normalized.events) if (keep(event.date)) kept.events.push(event);
  const used = new Set<string>();
  for (const row of [...kept.samples, ...kept.workouts, ...kept.events]) if (row.series_key) used.add(row.series_key);
  kept.series = normalized.series.filter((series) => used.has(series.key));
  return { normalized: kept, droppedStale, droppedFuture, droppedEarly };
}
