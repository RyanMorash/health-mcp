import {
  categoryEventKind,
  categorySuffix,
  ENERGY_METRICS,
  hkQuantityMetric,
  hkSide,
  hkWorkoutName,
  kindFor,
  sleepLabel,
  snakeCaseIdentifier,
  toKcal,
  wordsFromIdentifier,
} from "../catalog.js";
import { instant, localDate } from "../dates.js";
import { effectivePriority, mergeSpans, pickSleepSource, sourceRank, splitSample } from "./dedupe.js";
import { recordId, seriesKey } from "../id.js";
import {
  emptyNormalized,
  type EventKind,
  type HealthEvent,
  type MetricKind,
  type Normalized,
  type Sample,
  type SeriesObject,
  type Workout,
} from "../types.js";

const MAX_TAG_CHARS = 1_000_000;
const MAX_CAPTURE_CHARS = 2_000_000;
export const MAX_APPLE_UNCOMPRESSED_BYTES = 10_000_000_000;
export const APPLE_COMPRESSION_RATIO_FLOOR = 100_000_000;
export const APPLE_COMPRESSION_RATIO = 200;
const MAX_GPX_BYTES = 8_000_000;
const MAX_ROUTE_POINTS = 2_000;

export class AppleExportError extends Error {
  code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

const ZIP_UNZIP_HINT =
  "This zip is not a plain deflate archive. Unzip it with: ditto -x -k export.zip export-dir — then pass the export.xml file inside it.";

export function parseSourcePriority(value: unknown): string[] {
  if (value == null || value === false) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((name) => String(name).trim()).filter(Boolean);
}

export function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (entity, body: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, body)) return named[body];
    if (body[0] !== "#") return entity;
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity;
    return String.fromCodePoint(code);
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=<>/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(re)) out[match[1]] = decodeXml(match[3] ?? match[4] ?? "");
  return out;
}

function isBoundary(char: string | undefined): boolean {
  return char === " " || char === ">" || char === "/" || char === "\n" || char === "\r" || char === "\t";
}

function indexOfTagEnd(xml: string): number {
  let quote = "";
  for (let i = 0; i < xml.length; i += 1) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return i;
  }
  return -1;
}

function findClose(buf: string, name: string): { end: number; partial: false } | { at: number; partial: true } | null {
  const needle = `</${name}`;
  let from = 0;
  while (from < buf.length) {
    const at = buf.indexOf(needle, from);
    if (at < 0) return null;
    const next = buf[at + needle.length];
    if (next == null) return { at, partial: true };
    if (next === ">" || isBoundary(next)) {
      const gt = buf.indexOf(">", at);
      if (gt < 0) return { at, partial: true };
      return { end: gt + 1, partial: false };
    }
    from = at + needle.length;
  }
  return null;
}

function tagAt(buf: string, name: string): "yes" | "no" | "partial" {
  const needle = `<${name}`;
  if (!buf.startsWith(needle)) return needle.startsWith(buf) ? "partial" : "no";
  const next = buf[needle.length];
  if (next == null) return "partial";
  return isBoundary(next) ? "yes" : "no";
}

function elementName(buf: string): string | null | "partial" {
  if (!buf.startsWith("<") || buf.startsWith("</") || buf.startsWith("<!") || buf.startsWith("<?")) return null;
  const match = buf.match(/^<([A-Za-z][\w:.-]*)/);
  if (match) return match[1];
  if (buf.length < 64 && /^<[A-Za-z][\w:.-]*$/.test(buf)) return "partial";
  return null;
}

interface Bucket {
  metric: string;
  date: string;
  source: string;
  kind: MetricKind;
  side: "systolic" | "diastolic" | null;
  sum: number;
  n: number;
  min: number | null;
  max: number | null;
  lastTs: string;
  lastQty: number | null;
  units: string | null;
}

interface Span {
  metric: string;
  date: string;
  source: string;
  start: number;
  end: number;
  qty: number;
  units: string | null;
  kind: MetricKind;
}

interface DayTotal {
  metric: string;
  date: string;
  source: string;
  kind: MetricKind;
  qty: number;
  units: string | null;
}

interface Segment {
  metric: string;
  date: string;
  source: string;
  start: string;
  end: string;
  qty: number | null;
  units: string | null;
  label: string | null;
  kind: MetricKind;
}

function durationSeconds(value: string | undefined, unit: string | undefined): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const name = String(unit || "min").trim().toLowerCase();
  if (name === "min" || name === "mins" || name === "minute" || name === "minutes") return number * 60;
  if (name === "h" || name === "hr" || name === "hrs" || name === "hour" || name === "hours") return number * 3600;
  return number;
}

function finite(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export interface AppleParseOptions {
  timeZone?: string;
  sourcePriority?: unknown;
}

export function createAppleExportParser(options: AppleParseOptions = {}) {
  const timeZone = options.timeZone || "UTC";
  const priority = effectivePriority(parseSourcePriority(options.sourcePriority));
  const buckets = new Map<string, Bucket>();
  const spans: Span[] = [];
  let spanTick = 1;
  const segments = new Map<string, Segment>();
  const directSamples: Sample[] = [];
  const events: HealthEvent[] = [];
  const workouts: Workout[] = [];
  const activity: Record<string, Sample>[] = [];
  let buf = "";
  let mode: "text" | "comment" | "cdata" | "pi" | "doctype" | "capture" = "text";
  let skipping = "";
  let capturing = "";
  let capture = "";
  let sawExport = false;
  let exportDay: string | null = null;
  let doctypeState: { depth: number; quote: string; window: string } | null = null;

  function keep(date: string): boolean {
    return !exportDay || date < exportDay;
  }

  function addBucket(metric: string, date: string, source: string, ts: string, qty: number, units: string | null, side: "systolic" | "diastolic" | null) {
    if (!keep(date)) return;
    const kind = side ? "blood_pressure" : kindFor(metric);
    const key = `${metric}\0${date}\0${source}\0${side || ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { metric, date, source, kind, side, sum: 0, n: 0, min: null, max: null, lastTs: ts, lastQty: qty, units };
      buckets.set(key, bucket);
    }
    bucket.sum += qty;
    bucket.n += 1;
    bucket.min = bucket.min == null ? qty : Math.min(bucket.min, qty);
    bucket.max = bucket.max == null ? qty : Math.max(bucket.max, qty);
    if (ts >= bucket.lastTs) {
      bucket.lastTs = ts;
      bucket.lastQty = qty;
      bucket.units = units;
    }
  }

  function addCumulative(metric: string, source: string, startRaw: string, endRaw: string | undefined, qty: number, units: string | null) {
    const kind = kindFor(metric);
    for (const piece of splitSample(startRaw, endRaw, qty, timeZone, spanTick)) {
      spanTick += 1;
      if (!keep(piece.date)) continue;
      spans.push({ metric, date: piece.date, source, start: piece.start, end: piece.end, qty: piece.qty, units, kind });
    }
  }

  function addQuantity(attrs: Record<string, string>) {
    const metric = hkQuantityMetric(attrs.type);
    const ts = attrs.startDate || attrs.endDate;
    const qty = finite(attrs.value);
    if (!metric || !ts || qty == null) return;
    const side = hkSide(attrs.type);
    const stored = ENERGY_METRICS.has(metric) ? toKcal(qty, attrs.unit) : qty;
    const units = ENERGY_METRICS.has(metric) ? "kcal" : attrs.unit || null;
    const kind = kindFor(metric);
    if (!side && (kind === "sum" || kind === "quantity")) {
      addCumulative(metric, attrs.sourceName || "", ts, attrs.endDate || ts, stored, units);
      return;
    }
    const date = localDate(ts, timeZone);
    if (!date) return;
    if (side) {
      if (!keep(date)) return;
      directSamples.push({
        id: "",
        metric: "blood_pressure",
        date,
        start_ts: ts,
        end_ts: attrs.endDate || null,
        source: attrs.sourceName || "",
        qty: side === "systolic" ? stored : null,
        qty_min: side === "diastolic" ? stored : null,
        qty_avg: null,
        qty_max: side === "systolic" ? stored : null,
        units: units || "mmHg",
        label: null,
        extra: { systolic: side === "systolic" ? stored : null, diastolic: side === "diastolic" ? stored : null },
        kind: "blood_pressure",
        series_key: null,
      });
      return;
    }
    addBucket(metric, date, attrs.sourceName || "", ts, stored, units, null);
  }

  function addSleep(attrs: Record<string, string>) {
    const start = attrs.startDate;
    const end = attrs.endDate;
    if (!start || !end) return;
    const date = localDate(end, timeZone);
    if (!date || !keep(date)) return;
    const left = instant(start);
    const right = instant(end);
    const hours = left == null || right == null ? null : (right - left) / 3_600_000;
    const source = attrs.sourceName || "";
    segments.set(`${source}\0${start}\0${end}\0${attrs.value || ""}`, {
      metric: "sleep_analysis",
      date,
      source,
      start,
      end,
      qty: hours,
      units: "hr",
      label: sleepLabel(attrs.value || "Asleep"),
      kind: "sleep",
    });
  }

  function addCategory(attrs: Record<string, string>) {
    const suffix = categorySuffix(attrs.type);
    if (!suffix) return;
    if (suffix === "SleepAnalysis") {
      addSleep(attrs);
      return;
    }
    const start = attrs.startDate || attrs.endDate;
    const end = attrs.endDate || null;
    if (!start) return;
    const date = localDate(end || start, timeZone);
    if (!date || !keep(date)) return;
    const source = attrs.sourceName || "";
    if (suffix === "MindfulSession") {
      const left = instant(start);
      const right = end ? instant(end) : null;
      const minutes = left == null || right == null ? 0 : (right - left) / 60_000;
      addCumulative("mindful_minutes", source, start, end || start, minutes, "min");
      return;
    }
    if (suffix === "AppleStandHour") {
      const stood = /stood/i.test(attrs.value || "");
      if (stood) addCumulative("apple_stand_hour", source, start, end || start, 1, "count");
      return;
    }
    if (suffix === "HandwashingEvent" || suffix === "ToothbrushingEvent") {
      const left = instant(start);
      const right = end ? instant(end) : null;
      const seconds = left == null || right == null ? null : (right - left) / 1000;
      const metric = suffix === "HandwashingEvent" ? "handwashing" : "toothbrushing";
      directSamples.push({
        id: "",
        metric,
        date,
        start_ts: start,
        end_ts: end,
        source,
        qty: seconds,
        qty_min: null,
        qty_avg: null,
        qty_max: null,
        units: "s",
        label: attrs.value ? wordsFromIdentifier(attrs.value.replace(/^HKCategoryValue\w*/, "")) : null,
        extra: null,
        kind: "duration_label",
        series_key: null,
      });
      return;
    }
    if (suffix === "SexualActivity") {
      const label = wordsFromIdentifier((attrs.value || "Unspecified").replace(/^HKCategoryValueSexualActivity/, "")) || "Unspecified";
      directSamples.push({
        id: "",
        metric: "sexual_activity",
        date,
        start_ts: start,
        end_ts: end,
        source,
        qty: 1,
        qty_min: null,
        qty_avg: null,
        qty_max: null,
        units: "count",
        label,
        extra: null,
        kind: "category_count",
        series_key: null,
      });
      return;
    }
    const eventKind = categoryEventKind(suffix);
    events.push(makeEvent(eventKind || "record", snakeCaseIdentifier(suffix), start, end, date, source, {
      type: attrs.type,
      value: attrs.value || null,
    }));
  }

  function makeEvent(kind: EventKind, subtype: string, start: string, end: string | null, date: string, source: string, payload: Record<string, unknown>): HealthEvent {
    return {
      id: "",
      kind,
      subtype,
      start_ts: start,
      end_ts: end,
      date,
      source: source || null,
      payload,
      series_key: null,
    };
  }

  function addCorrelation(xml: string) {
    const openEnd = indexOfTagEnd(xml);
    const open = openEnd >= 0 ? xml.slice(0, openEnd + 1) : xml;
    const attrs = attributes(open);
    if (!String(attrs.type || "").includes("BloodPressure")) {
      addUnknown("Correlation", attrs);
      return;
    }
    const start = attrs.startDate || attrs.endDate;
    if (!start) return;
    const date = localDate(start, timeZone);
    if (!date || !keep(date)) return;
    let systolic: number | null = null;
    let diastolic: number | null = null;
    let units: string | null = null;
    for (const match of xml.matchAll(/<Record\b[^>]*>/g)) {
      const record = attributes(match[0]);
      const side = hkSide(record.type);
      const qty = finite(record.value);
      if (side === "systolic") systolic = qty;
      if (side === "diastolic") diastolic = qty;
      if (record.unit) units = record.unit;
    }
    directSamples.push({
      id: "",
      metric: "blood_pressure",
      date,
      start_ts: start,
      end_ts: attrs.endDate || null,
      source: attrs.sourceName || "",
      qty: systolic,
      qty_min: diastolic,
      qty_avg: null,
      qty_max: systolic,
      units: units || "mmHg",
      label: null,
      extra: { systolic, diastolic },
      kind: "blood_pressure",
      series_key: null,
    });
  }

  function addWorkout(xml: string) {
    const openEnd = indexOfTagEnd(xml);
    const open = openEnd >= 0 ? xml.slice(0, openEnd + 1) : xml;
    const attrs = attributes(open);
    const start = attrs.startDate;
    if (!start) return;
    const date = localDate(start, timeZone);
    if (!date || !keep(date)) return;
    let seconds = durationSeconds(attrs.duration, attrs.durationUnit);
    if (seconds == null && attrs.endDate) {
      const left = instant(start);
      const right = instant(attrs.endDate);
      if (left != null && right != null) seconds = (right - left) / 1000;
    }
    const kcal = finite(attrs.totalEnergyBurned);
    const distance = finite(attrs.totalDistance);
    let hrMin: number | null = null;
    let hrAvg: number | null = null;
    let hrMax: number | null = null;
    for (const match of xml.matchAll(/<WorkoutStatistics\b[^>]*\/?>/g)) {
      const stat = attributes(match[0]);
      if (!String(stat.type || "").includes("HeartRate")) continue;
      hrMin = finite(stat.minimum);
      hrAvg = finite(stat.average);
      hrMax = finite(stat.maximum);
    }
    let routePath: string | null = null;
    const file = xml.match(/<FileReference\b[^>]*\/?>/);
    if (file) routePath = attributes(file[0]).path || null;
    workouts.push({
      id: "",
      name: hkWorkoutName(attrs.workoutActivityType || ""),
      start_ts: start,
      end_ts: attrs.endDate || null,
      date,
      duration_s: seconds,
      active_kcal: kcal == null ? null : Math.round(toKcal(kcal, attrs.totalEnergyBurnedUnit)),
      total_kcal: kcal == null ? null : Math.round(toKcal(kcal, attrs.totalEnergyBurnedUnit)),
      distance_qty: distance,
      distance_units: attrs.totalDistanceUnit || null,
      hr_min: hrMin,
      hr_avg: hrAvg,
      hr_max: hrMax,
      location: attrs.indoorWorkout === "1" ? "Indoor" : null,
      source: attrs.sourceName || null,
      summary: routePath ? { route_path: routePath } : null,
      series_key: null,
    });
  }

  function addActivity(attrs: Record<string, string>) {
    const date = attrs.dateComponents;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !keep(date)) return;
    const rows: Record<string, Sample> = {};
    const push = (metric: string, qty: number | null, units: string) => {
      if (qty == null) return;
      rows[metric] = {
        id: "",
        metric,
        date,
        start_ts: `${date} 00:00:00`,
        end_ts: null,
        source: "ActivitySummary",
        qty,
        qty_min: null,
        qty_avg: null,
        qty_max: null,
        units,
        label: null,
        extra: null,
        kind: kindFor(metric),
        series_key: null,
      };
    };
    push("apple_exercise_time", finite(attrs.appleExerciseTime), "min");
    push("apple_stand_hour", finite(attrs.appleStandHours), "count");
    push("active_energy", finite(attrs.activeEnergyBurned), "kcal");
    if (Object.keys(rows).length) activity.push(rows);
  }

  function addStateOfMind(attrs: Record<string, string>) {
    const start = attrs.startDate || attrs.endDate;
    if (!start) return;
    const date = localDate(attrs.endDate || start, timeZone);
    if (!date || !keep(date)) return;
    events.push(makeEvent("state_of_mind", attrs.kind || "state_of_mind", start, attrs.endDate || null, date, attrs.sourceName || "", { ...attrs }));
  }

  function addUnknown(name: string, attrs: Record<string, string>) {
    const start = attrs.startDate || attrs.endDate || attrs.creationDate || attrs.dateComponents;
    if (!start) return;
    const date = localDate(start, timeZone);
    if (!date || !keep(date)) return;
    const lower = name.toLowerCase();
    let kind: EventKind = "record";
    if (lower.includes("electrocardiogram")) kind = "ecg";
    else if (lower.includes("medication")) kind = "medication";
    else if (lower.includes("stateofmind")) kind = "state_of_mind";
    events.push(makeEvent(kind, snakeCaseIdentifier(attrs.type || name), start, attrs.endDate || null, date, attrs.sourceName || "", { element: name, ...attrs }));
  }

  function processElement(name: string, xml: string) {
    const openEnd = indexOfTagEnd(xml);
    const attrs = attributes(openEnd >= 0 ? xml.slice(0, openEnd + 1) : xml);
    if (name === "Record") {
      if (categorySuffix(attrs.type)) addCategory(attrs);
      else addQuantity(attrs);
      return;
    }
    if (name === "Workout") {
      addWorkout(xml);
      return;
    }
    if (name === "Correlation") {
      addCorrelation(xml);
      return;
    }
    if (name === "ActivitySummary") {
      addActivity(attrs);
      return;
    }
    if (name === "StateOfMind") {
      addStateOfMind(attrs);
      return;
    }
    if (name === "ExportDate") {
      if (attrs.value) exportDay = localDate(attrs.value, timeZone) || exportDay;
      return;
    }
    if (name !== "HealthData") addUnknown(name, attrs);
  }

  function takeTag(name: string): boolean {
    const end = indexOfTagEnd(buf);
    if (end < 0) {
      if (buf.length > MAX_TAG_CHARS) throw new AppleExportError("INVALID_EXPORT");
      return false;
    }
    const tag = buf.slice(0, end + 1);
    buf = buf.slice(end + 1);
    sawExport = true;
    if (!tag.endsWith("/>") && name !== "HealthData" && name !== "ExportDate") {
      capturing = name;
      capture = tag;
      mode = "capture";
      return true;
    }
    processElement(name, tag);
    return true;
  }

  function scanDoctype(): boolean {
    if (!doctypeState) return false;
    let index = 0;
    while (index < buf.length) {
      const char = buf[index];
      if (doctypeState.quote) {
        if (char === doctypeState.quote) doctypeState.quote = "";
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        doctypeState.quote = char;
        index += 1;
        continue;
      }
      doctypeState.window = (doctypeState.window + char).slice(-24);
      if (/<!ENTITY[\s>]/i.test(doctypeState.window)) throw new AppleExportError("INVALID_EXPORT");
      if (/(?:^|[^A-Za-z])SYSTEM[^A-Za-z]/.test(doctypeState.window)) throw new AppleExportError("INVALID_EXPORT");
      if (/(?:^|[^A-Za-z])PUBLIC[^A-Za-z]/.test(doctypeState.window)) throw new AppleExportError("INVALID_EXPORT");
      if (char === "[") doctypeState.depth += 1;
      else if (char === "]" && doctypeState.depth > 0) doctypeState.depth -= 1;
      else if (char === ">" && doctypeState.depth === 0) {
        buf = buf.slice(index + 1);
        return true;
      }
      index += 1;
    }
    buf = "";
    return false;
  }

  function pump() {
    while (buf.length || mode === "doctype" || mode === "capture") {
      if (mode === "capture") {
        const closed = findClose(buf, capturing);
        if (!closed) {
          if (capture.length + buf.length > MAX_CAPTURE_CHARS) throw new AppleExportError("PAYLOAD_TOO_LARGE");
          capture += buf;
          buf = "";
          return;
        }
        if (closed.partial) {
          capture += buf.slice(0, closed.at);
          buf = buf.slice(closed.at);
          return;
        }
        capture += buf.slice(0, closed.end);
        buf = buf.slice(closed.end);
        const name = capturing;
        const xml = capture;
        capturing = "";
        capture = "";
        mode = "text";
        processElement(name, xml);
        continue;
      }
      if (mode === "comment") {
        const end = buf.indexOf("-->");
        if (end < 0) {
          buf = buf.slice(Math.max(0, buf.length - 2));
          return;
        }
        buf = buf.slice(end + 3);
        mode = "text";
        continue;
      }
      if (mode === "cdata") {
        const end = buf.indexOf("]]>");
        if (end < 0) {
          buf = buf.slice(Math.max(0, buf.length - 2));
          return;
        }
        buf = buf.slice(end + 3);
        mode = "text";
        continue;
      }
      if (mode === "pi") {
        const end = buf.indexOf("?>");
        if (end < 0) {
          buf = buf.slice(Math.max(0, buf.length - 1));
          return;
        }
        buf = buf.slice(end + 2);
        mode = "text";
        continue;
      }
      if (mode === "doctype") {
        if (!buf.length) return;
        if (!scanDoctype()) return;
        mode = "text";
        doctypeState = null;
        continue;
      }
      if (skipping) {
        const closed = findClose(buf, skipping);
        if (!closed) {
          buf = buf.slice(Math.max(0, buf.length - 24));
          return;
        }
        if (closed.partial) {
          buf = buf.slice(closed.at);
          return;
        }
        buf = buf.slice(closed.end);
        skipping = "";
        continue;
      }
      if (!buf.length) return;
      const start = buf.indexOf("<");
      if (start < 0) {
        buf = "";
        return;
      }
      if (start > 0) buf = buf.slice(start);
      if (buf.startsWith("<!--")) {
        mode = "comment";
        buf = buf.slice(4);
        continue;
      }
      if ("<!--".startsWith(buf)) return;
      if (buf.startsWith("<![CDATA[")) {
        mode = "cdata";
        buf = buf.slice(9);
        continue;
      }
      if ("<![CDATA[".startsWith(buf)) return;
      if (buf.startsWith("<?")) {
        mode = "pi";
        buf = buf.slice(2);
        continue;
      }
      if (buf === "<") return;
      if (/^<!DOCTYPE(?=[\s>])/i.test(buf)) {
        mode = "doctype";
        doctypeState = { depth: 0, quote: "", window: "" };
        buf = buf.slice(buf.match(/^<!DOCTYPE/i)![0].length);
        continue;
      }
      if (/^<!DOC/i.test(buf) && buf.length < "<!DOCTYPE ".length) return;
      if (/^<!ENTITY(?=[\s>])/i.test(buf)) throw new AppleExportError("INVALID_EXPORT");
      if (/^<!ENT/i.test(buf) && buf.length < "<!ENTITY ".length) return;
      if (buf.startsWith("<!")) {
        const end = indexOfTagEnd(buf);
        if (end < 0) {
          if (buf.length > MAX_TAG_CHARS) throw new AppleExportError("INVALID_EXPORT");
          return;
        }
        buf = buf.slice(end + 1);
        continue;
      }
      const name = elementName(buf);
      if (name === "partial") return;
      if (!name) {
        const end = indexOfTagEnd(buf);
        if (end < 0) {
          if (buf.length > MAX_TAG_CHARS) throw new AppleExportError("INVALID_EXPORT");
          return;
        }
        buf = buf.slice(end + 1);
        continue;
      }
      const kind = tagAt(buf, name);
      if (kind === "partial") return;
      if (!takeTag(name)) return;
    }
  }

  function chooseBucket(list: Bucket[]): Bucket {
    return list.slice().sort((a, b) => {
      if (a.kind === "latest" || b.kind === "latest") {
        const left = instant(a.lastTs) ?? 0;
        const right = instant(b.lastTs) ?? 0;
        if (left !== right) return right - left;
      }
      const rank = sourceRank(a.source, priority) - sourceRank(b.source, priority);
      if (rank !== 0) return rank;
      return b.n - a.n;
    })[0];
  }

  return {
    push(text: string) {
      if (text) buf += text;
      pump();
    },
    finish(): { exportDay: string | null; buckets: Bucket[]; totals: DayTotal[]; segments: Segment[]; directSamples: Sample[]; events: HealthEvent[]; workouts: Workout[]; activity: Record<string, Sample>[] } {
      pump();
      if (mode !== "text" || skipping || capturing || doctypeState) throw new AppleExportError("INVALID_EXPORT");
      if (!sawExport) throw new AppleExportError("INVALID_EXPORT");
      const groups = new Map<string, Bucket[]>();
      for (const bucket of buckets.values()) {
        const key = `${bucket.metric}\0${bucket.date}\0${bucket.side || ""}`;
        const list = groups.get(key);
        if (list) list.push(bucket);
        else groups.set(key, [bucket]);
      }
      const chosen: Bucket[] = [];
      for (const list of groups.values()) chosen.push(chooseBucket(list));
      const spanGroups = new Map<string, Span[]>();
      for (const span of spans) {
        const key = `${span.metric}\0${span.date}`;
        const list = spanGroups.get(key);
        if (list) list.push(span);
        else spanGroups.set(key, [span]);
      }
      const totals: DayTotal[] = [];
      for (const list of spanGroups.values()) {
        const merged = mergeSpans(list, priority);
        if (!merged) continue;
        totals.push({ metric: list[0].metric, date: list[0].date, kind: list[0].kind, ...merged });
      }
      const sleepGroups = new Map<string, Segment[]>();
      for (const segment of segments.values()) {
        const list = sleepGroups.get(segment.date);
        if (list) list.push(segment);
        else sleepGroups.set(segment.date, [segment]);
      }
      const keptSegments: Segment[] = [];
      for (const list of sleepGroups.values()) {
        const picked = pickSleepSource(list, priority);
        keptSegments.push(...list.filter((segment) => segment.source === picked));
      }
      return {
        exportDay,
        buckets: chosen,
        totals,
        segments: keptSegments,
        directSamples,
        events,
        workouts,
        activity,
      };
    },
  };
}

async function sampleFromBucket(bucket: Bucket): Promise<Sample> {
  const kind = bucket.side ? "blood_pressure" : bucket.kind;
  const qty = kind === "latest" ? bucket.lastQty : kind === "min_avg_max" ? (bucket.n ? bucket.sum / bucket.n : null) : bucket.sum;
  return {
    id: await recordId(["day", bucket.metric, bucket.date, bucket.side || bucket.kind]),
    metric: bucket.metric,
    date: bucket.date,
    start_ts: kind === "latest" ? bucket.lastTs : `${bucket.date} 00:00:00`,
    end_ts: kind === "latest" ? null : bucket.lastTs,
    source: bucket.source,
    qty: bucket.side === "diastolic" ? null : qty,
    qty_min: bucket.side === "diastolic" ? bucket.lastQty : kind === "min_avg_max" ? bucket.min : null,
    qty_avg: kind === "min_avg_max" ? qty : null,
    qty_max: bucket.side === "systolic" ? bucket.lastQty : kind === "min_avg_max" ? bucket.max : null,
    units: bucket.units,
    label: null,
    extra: bucket.side ? { systolic: bucket.side === "systolic" ? bucket.lastQty : null, diastolic: bucket.side === "diastolic" ? bucket.lastQty : null } : null,
    kind,
    series_key: null,
  };
}

async function sampleFromTotal(total: DayTotal): Promise<Sample> {
  return {
    id: await recordId(["day", total.metric, total.date]),
    metric: total.metric,
    date: total.date,
    start_ts: `${total.date} 00:00:00`,
    end_ts: null,
    source: total.source,
    qty: total.qty,
    qty_min: null,
    qty_avg: null,
    qty_max: null,
    units: total.units,
    label: null,
    extra: null,
    kind: total.kind,
    series_key: null,
  };
}

async function seal(result: ReturnType<ReturnType<typeof createAppleExportParser>["finish"]>): Promise<Normalized> {
  const present = new Set([
    ...result.buckets.map((bucket) => `${bucket.metric}\0${bucket.date}`),
    ...result.totals.map((total) => `${total.metric}\0${total.date}`),
  ]);
  const samples: Sample[] = [];
  for (const total of result.totals) samples.push(await sampleFromTotal(total));
  for (const bucket of result.buckets) samples.push(await sampleFromBucket(bucket));
  for (const rows of result.activity) {
    for (const sample of Object.values(rows)) {
      if (present.has(`${sample.metric}\0${sample.date}`)) continue;
      sample.id = await recordId(["activity", sample.metric, sample.date]);
      samples.push(sample);
      present.add(`${sample.metric}\0${sample.date}`);
    }
  }
  for (const segment of result.segments) {
    samples.push({
      id: await recordId(["segment", segment.metric, segment.start, segment.end, segment.source, segment.label]),
      metric: segment.metric,
      date: segment.date,
      start_ts: segment.start,
      end_ts: segment.end,
      source: segment.source,
      qty: segment.qty,
      qty_min: null,
      qty_avg: null,
      qty_max: null,
      units: segment.units,
      label: segment.label,
      extra: null,
      kind: segment.kind,
      series_key: null,
    });
  }
  for (const sample of result.directSamples) {
    sample.id = sample.id || (await recordId(["direct", sample.metric, sample.start_ts, sample.end_ts, sample.source, sample.label]));
    samples.push(sample);
  }
  const events: HealthEvent[] = [];
  for (const event of result.events) {
    event.id = event.id || (await recordId(["event", event.kind, event.subtype, event.start_ts, event.source]));
    events.push(event);
  }
  const workouts: Workout[] = [];
  for (const workout of result.workouts) {
    workout.id = workout.id || (await recordId(["workout", workout.name, workout.start_ts, workout.source]));
    workouts.push(workout);
  }
  for (const sample of samples) sample.extra = { ...(sample.extra || {}), apple: true };
  return { samples, workouts, events, series: [] };
}

function assertDecompressionBudget(compSize: number, uncompressed: number) {
  if (uncompressed > MAX_APPLE_UNCOMPRESSED_BYTES || compSize > MAX_APPLE_UNCOMPRESSED_BYTES) throw new AppleExportError("PAYLOAD_TOO_LARGE");
  if (compSize > 0 && uncompressed > APPLE_COMPRESSION_RATIO_FLOOR && uncompressed / compSize > APPLE_COMPRESSION_RATIO) {
    throw new AppleExportError("PAYLOAD_TOO_LARGE");
  }
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

class ByteQueue {
  private iterator: AsyncIterator<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private offset = 0;
  private done = false;
  bytesRead = 0;

  constructor(iterator: AsyncIterator<Uint8Array>) {
    this.iterator = iterator;
  }

  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
    if (!chunk.length) return this.pull();
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    return true;
  }

  async read(size: number): Promise<Uint8Array> {
    while (this.buffered < size && !this.done) {
      if (!(await this.pull())) break;
    }
    const take = Math.min(size, this.buffered);
    const out = new Uint8Array(take);
    let filled = 0;
    while (filled < take) {
      const chunk = this.chunks[0];
      const slice = Math.min(chunk.length - this.offset, take - filled);
      out.set(chunk.subarray(this.offset, this.offset + slice), filled);
      filled += slice;
      this.offset += slice;
      this.buffered -= slice;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.bytesRead += take;
    return out;
  }

  async readExact(size: number): Promise<Uint8Array> {
    const out = await this.read(size);
    if (out.length !== size) throw new AppleExportError("INVALID_ZIP");
    return out;
  }

  async skip(size: number) {
    let left = size;
    while (left > 0) {
      const chunk = await this.read(Math.min(left, 65536));
      if (!chunk.length) throw new AppleExportError("INVALID_ZIP");
      left -= chunk.length;
    }
  }
}

async function inflateEntry(queue: ByteQueue, method: number, compSize: number, uncompressed: number, accept: (text: string) => void) {
  assertDecompressionBudget(compSize, uncompressed);
  const decoder = new TextDecoder();
  let produced = 0;
  const take = (bytes: Uint8Array) => {
    produced += bytes.byteLength;
    if (produced > uncompressed || produced > MAX_APPLE_UNCOMPRESSED_BYTES) throw new AppleExportError("PAYLOAD_TOO_LARGE");
    if (compSize > 0 && produced > APPLE_COMPRESSION_RATIO_FLOOR && produced / compSize > APPLE_COMPRESSION_RATIO) {
      throw new AppleExportError("PAYLOAD_TOO_LARGE");
    }
    accept(decoder.decode(bytes, { stream: true }));
  };
  if (method === 0) {
    let left = compSize;
    while (left > 0) {
      const chunk = await queue.readExact(Math.min(left, 65536));
      left -= chunk.length;
      take(chunk);
    }
    accept(decoder.decode());
    return;
  }
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const pump = (async () => {
    let left = compSize;
    while (left > 0) {
      const chunk = await queue.readExact(Math.min(left, 65536));
      left -= chunk.length;
      await writer.write(chunk);
    }
    await writer.close();
  })();
  const consume = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      take(value);
    }
    accept(decoder.decode());
  })();
  try {
    await Promise.all([pump, consume]);
  } catch (error) {
    if (error instanceof AppleExportError) throw error;
    throw new AppleExportError("INVALID_ZIP");
  }
}

async function readZip(queue: ByteQueue, parser: ReturnType<typeof createAppleExportParser>): Promise<Map<string, string>> {
  const gpx = new Map<string, string>();
  let gpxBytes = 0;
  let found = false;
  while (true) {
    const raw = await queue.read(4);
    if (raw.length < 4) {
      if (!found) throw new AppleExportError("INVALID_EXPORT");
      return gpx;
    }
    const signature = u32(raw, 0);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      if (!found) throw new AppleExportError("INVALID_EXPORT");
      return gpx;
    }
    if (signature !== 0x04034b50) throw new AppleExportError("INVALID_ZIP");
    const header = await queue.readExact(26);
    const flags = u16(header, 2);
    const method = u16(header, 4);
    const compSize = u32(header, 14);
    const uncompressed = u32(header, 18);
    const nameLen = u16(header, 22);
    const extraLen = u16(header, 24);
    if (flags & 0x1) throw new AppleExportError("UNSUPPORTED_ZIP", `${ZIP_UNZIP_HINT} The entry is encrypted.`);
    if (method !== 0 && method !== 8) throw new AppleExportError("UNSUPPORTED_ZIP", `${ZIP_UNZIP_HINT} Compression method ${method} is not supported.`);
    if (compSize === 0xffffffff || uncompressed === 0xffffffff) throw new AppleExportError("UNSUPPORTED_ZIP", `${ZIP_UNZIP_HINT} The entry uses zip64 sizes.`);
    if ((flags & 0x8) && (compSize === 0 || uncompressed === 0)) {
      throw new AppleExportError("UNSUPPORTED_ZIP", `${ZIP_UNZIP_HINT} The entry stores its size in a data descriptor.`);
    }
    const name = new TextDecoder().decode(await queue.readExact(nameLen)).replaceAll("\\", "/");
    await queue.skip(extraLen);
    const lower = name.toLowerCase();
    const xml = lower.endsWith("/export.xml") || lower === "export.xml";
    const route = lower.endsWith(".gpx") && gpxBytes + uncompressed <= MAX_GPX_BYTES;
    if (!xml && !route) {
      await queue.skip(compSize);
      continue;
    }
    let text = "";
    await inflateEntry(queue, method, compSize, uncompressed, (chunk) => {
      text += chunk;
    });
    if (xml) {
      found = true;
      parser.push(text);
    } else {
      gpxBytes += uncompressed;
      gpx.set(name.replace(/^\//, ""), text);
      gpx.set(name, text);
    }
  }
}

function parseGpx(xml: string): { latitude: number; longitude: number; altitude: number | null; timestamp: string | null }[] {
  const points = [];
  for (const match of xml.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)) {
    if (points.length >= MAX_ROUTE_POINTS) break;
    const attrs = attributes(`<trkpt ${match[1]}>`);
    const latitude = Number(attrs.lat);
    const longitude = Number(attrs.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const ele = match[2].match(/<ele>(-?\d+(?:\.\d+)?)<\/ele>/);
    const time = match[2].match(/<time>([^<]+)<\/time>/);
    points.push({
      latitude,
      longitude,
      altitude: ele ? Number(ele[1]) : null,
      timestamp: time ? time[1] : null,
    });
  }
  return points;
}

async function attachRoutes(normalized: Normalized, gpx: Map<string, string>) {
  const series: SeriesObject[] = [];
  for (const workout of normalized.workouts) {
    const path = typeof workout.summary?.route_path === "string" ? workout.summary.route_path : "";
    if (!path) continue;
    const text = gpx.get(path) || gpx.get(path.replace(/^\//, ""));
    if (!text) continue;
    const route = parseGpx(text);
    if (!route.length) continue;
    const key = await seriesKey({ route });
    workout.series_key = key;
    series.push({ key, body: { route } });
  }
  normalized.series = series;
}

async function parseQueue(queue: ByteQueue, parser: ReturnType<typeof createAppleExportParser>): Promise<Map<string, string>> {
  const head = await queue.read(4);
  const zip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (zip) {
    const pending = new Uint8Array(head.length);
    pending.set(head);
    const prefixed = (async function* prefixedBytes() {
      yield pending;
      while (true) {
        const chunk = await queue.read(65536);
        if (!chunk.length) return;
        yield chunk;
      }
    })();
    return readZip(new ByteQueue(prefixed[Symbol.asyncIterator]()), parser);
  }
  const decoder = new TextDecoder();
  if (head.length) parser.push(decoder.decode(head, { stream: true }));
  while (true) {
    const chunk = await queue.read(65536);
    if (!chunk.length) break;
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.push(decoder.decode());
  return new Map();
}

/** Parse export.xml or a zip that contains it into the shared record model. */
export async function parseAppleExport(source: string | Uint8Array | AsyncIterable<Uint8Array>, options: AppleParseOptions = {}): Promise<Normalized & { bytes: number; exportDay: string | null }> {
  const parser = createAppleExportParser(options);
  let bytes = 0;
  let gpx = new Map<string, string>();
  if (typeof source === "string") {
    parser.push(source);
    bytes = new TextEncoder().encode(source).byteLength;
  } else {
    const iterable = source instanceof Uint8Array ? (async function* bytesOnly() { yield source; })() : source;
    const queue = new ByteQueue(iterable[Symbol.asyncIterator]());
    gpx = await parseQueue(queue, parser);
    bytes = queue.bytesRead;
  }
  const finished = parser.finish();
  const normalized = await seal(finished);
  if (gpx.size) await attachRoutes(normalized, gpx);
  return { ...normalized, bytes, exportDay: finished.exportDay };
}

/** Split normalized records into posts that each contain whole dates. */
export function chunkNormalized(normalized: Normalized, datesPerChunk = 31): Normalized[] {
  const size = Math.max(1, datesPerChunk);
  const dates = [...new Set([...normalized.samples, ...normalized.workouts, ...normalized.events].map((row) => row.date))].sort();
  const chunks: Normalized[] = [];
  for (let index = 0; index < dates.length; index += size) {
    const window = new Set(dates.slice(index, index + size));
    const samples = normalized.samples.filter((row) => window.has(row.date));
    const workouts = normalized.workouts.filter((row) => window.has(row.date));
    const events = normalized.events.filter((row) => window.has(row.date));
    const used = new Set<string>();
    for (const row of [...samples, ...workouts, ...events]) if (row.series_key) used.add(row.series_key);
    chunks.push({
      samples,
      workouts,
      events,
      series: normalized.series.filter((series) => used.has(series.key)),
    });
  }
  return chunks;
}
