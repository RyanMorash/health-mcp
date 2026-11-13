import { instant, localDate } from "../dates.js";

/** Watch over iPhone when the importer is not given an explicit list. */
export const DEFAULT_SOURCE_PRIORITY = ["Apple Watch", "iPhone"];

const ASLEEP_LABELS = new Set(["Asleep", "Core", "Deep", "REM"]);

export interface TimedSample {
  source: string;
  start: number;
  end: number;
  qty: number;
  units: string | null;
}

export interface MergedTotal {
  qty: number;
  source: string;
  units: string | null;
}

export interface DayPiece {
  date: string;
  start: number;
  end: number;
  qty: number;
}

/** Curly apostrophes and case do not keep two spellings of one device apart. */
export function normalizeSourceName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\uFF07`']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function deviceClass(normalized: string): "watch" | "iphone" | null {
  if (normalized.includes("apple watch") || /(?:^|[^a-z])watch(?:[^a-z]|$)/.test(normalized)) return "watch";
  if (normalized.includes("iphone")) return "iphone";
  return null;
}

/** Lower rank wins. Every iPhone generation shares a rank, and so does every Watch. */
export function sourceRank(source: string, priority: string[]): number {
  const normalized = normalizeSourceName(source);
  const sourceClass = deviceClass(normalized);
  for (let index = 0; index < priority.length; index += 1) {
    const term = normalizeSourceName(priority[index] || "");
    if (!term) continue;
    if (normalized.includes(term)) return index;
    if (sourceClass && sourceClass === deviceClass(term)) return index;
  }
  return priority.length;
}

export function effectivePriority(requested: string[]): string[] {
  return requested.length ? requested : DEFAULT_SOURCE_PRIORITY;
}

function timestampOffsetMs(value: string): number | null {
  const match = value.match(/([+-])(\d{2}):?(\d{2})\s*$/);
  if (!match) return null;
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

function formatOffsetDate(ms: number, offsetMs: number): string {
  const local = new Date(ms + offsetMs);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextOffsetMidnight(ms: number, offsetMs: number): number {
  const local = new Date(ms + offsetMs);
  const next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  return next - offsetMs;
}

function zonedParts(ms: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return { year: Number(bag.year), month: Number(bag.month), day: Number(bag.day), hour, minute: Number(bag.minute), second: Number(bag.second) };
}

function formatZonedDate(ms: number, timeZone: string): string {
  const parts = zonedParts(ms, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  let utc = Date.UTC(year, month - 1, day);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const got = zonedParts(utc, timeZone);
    const delta = Date.UTC(year, month - 1, day) - Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    if (delta === 0) return utc;
    utc += delta;
  }
  return utc;
}

function nextZonedMidnight(ms: number, timeZone: string): number {
  const parts = zonedParts(ms, timeZone);
  return zonedMidnight(parts.year, parts.month, parts.day + 1, timeZone);
}

/**
 * Split one sample across local midnights. Apple timestamps carry the device
 * offset, and that calendar date is the day the sample belongs to.
 */
export function splitSample(startRaw: string, endRaw: string | undefined, qty: number, timeZone: string, tick: number): DayPiece[] {
  const startMs = instant(startRaw);
  if (startMs == null) {
    const date = localDate(startRaw, timeZone);
    if (!date) return [];
    return [{ date, start: -tick, end: -tick, qty }];
  }
  const endMs = endRaw ? instant(endRaw) : null;
  const offset = timestampOffsetMs(startRaw);
  const endOffset = endRaw ? timestampOffsetMs(endRaw) : null;
  const stableOffset = offset != null && offset === endOffset ? offset : null;
  if (!(endMs != null && endMs > startMs)) {
    const date = stableOffset != null ? formatOffsetDate(startMs, stableOffset) : formatZonedDate(startMs, timeZone);
    return [{ date, start: startMs, end: startMs, qty }];
  }
  const total = endMs - startMs;
  const pieces: DayPiece[] = [];
  let cursor = startMs;
  for (let guard = 0; guard < 400 && cursor < endMs; guard += 1) {
    const date = stableOffset != null ? formatOffsetDate(cursor, stableOffset) : formatZonedDate(cursor, timeZone);
    const next = stableOffset != null ? nextOffsetMidnight(cursor, stableOffset) : nextZonedMidnight(cursor, timeZone);
    const sliceEnd = Math.min(endMs, next > cursor ? next : endMs);
    const part = sliceEnd - cursor;
    if (part > 0) pieces.push({ date, start: cursor, end: sliceEnd, qty: (qty * part) / total });
    if (!(sliceEnd > cursor)) break;
    cursor = sliceEnd;
  }
  return pieces;
}

function subtract(start: number, end: number, covered: { start: number; end: number }[]): { start: number; end: number }[] {
  let parts = [{ start, end }];
  for (const block of covered) {
    const next: { start: number; end: number }[] = [];
    for (const part of parts) {
      if (block.end <= part.start || block.start >= part.end) {
        next.push(part);
        continue;
      }
      if (block.start > part.start) next.push({ start: part.start, end: Math.min(block.start, part.end) });
      if (block.end < part.end) next.push({ start: Math.max(block.end, part.start), end: part.end });
    }
    parts = next;
    if (!parts.length) break;
  }
  return parts.filter((part) => part.end > part.start);
}

/**
 * Higher-priority time wins. A lower-priority sample keeps only the part of
 * its interval that nobody above it already covered, and its quantity is
 * scaled by that fraction. Same-class devices share a rank, so two iPhones
 * do not both count the same minute.
 */
export function mergeSpans(samples: TimedSample[], priority: string[]): MergedTotal | null {
  if (!samples.length) return null;
  const ranked = samples.map((sample) => ({ ...sample, rank: sourceRank(sample.source, priority) }));
  ranked.sort((a, b) => a.rank - b.rank || a.start - b.start || a.end - b.end || a.source.localeCompare(b.source));
  const covered: { start: number; end: number }[] = [];
  const points = new Set<number>();
  let qty = 0;
  let source = ranked[0].source;
  let units = ranked[0].units;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const sample of ranked) {
    const duration = sample.end - sample.start;
    let added = 0;
    if (duration <= 0) {
      const coveredByRange = covered.some((block) => sample.start >= block.start && sample.start < block.end);
      if (coveredByRange || points.has(sample.start)) continue;
      points.add(sample.start);
      added = sample.qty;
    } else {
      const open = subtract(sample.start, sample.end, covered);
      const uncovered = open.reduce((sum, part) => sum + (part.end - part.start), 0);
      if (uncovered <= 0) continue;
      added = sample.qty * (uncovered / duration);
      covered.push({ start: sample.start, end: sample.end });
    }
    if (!(added > 0)) continue;
    qty += added;
    if (sample.rank < bestRank) {
      bestRank = sample.rank;
      source = sample.source;
      units = sample.units ?? units;
    }
  }
  if (!(qty > 0)) return null;
  return { qty, source, units };
}

export function pickSleepSource(segments: { source: string; label: string | null; qty: number | null }[], priority: string[]): string {
  const bySource = new Map<string, { asleep: number; count: number }>();
  for (const segment of segments) {
    const row = bySource.get(segment.source) ?? { asleep: 0, count: 0 };
    row.count += 1;
    if (segment.label && ASLEEP_LABELS.has(segment.label)) row.asleep += segment.qty || 0;
    bySource.set(segment.source, row);
  }
  const sources = [...bySource.keys()];
  const withSleep = sources.filter((source) => (bySource.get(source)?.asleep || 0) > 0);
  const candidates = withSleep.length ? withSleep : sources;
  candidates.sort((a, b) => {
    const rank = sleepRank(a, priority) - sleepRank(b, priority);
    if (rank !== 0) return rank;
    const asleep = (bySource.get(b)?.asleep || 0) - (bySource.get(a)?.asleep || 0);
    if (asleep !== 0) return asleep;
    return (bySource.get(b)?.count || 0) - (bySource.get(a)?.count || 0);
  });
  return candidates[0] || "";
}

function sleepRank(source: string, priority: string[]): number {
  const rank = sourceRank(source, priority);
  if (rank === priority.length && normalizeSourceName(source).includes("clock")) return rank + 1;
  return rank;
}
