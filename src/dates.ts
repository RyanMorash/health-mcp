export const DEFAULT_TIME_ZONE = "UTC";

const OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?/;

/** Calendar day for a Health Auto Export or Apple Health timestamp. */
export function localDate(value: unknown, timeZone = DEFAULT_TIME_ZONE): string | null {
  if (value == null || value === "") return null;
  const text = String(value);
  const match = text.match(OFFSET_RE);
  if (match?.[3]) return match[1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function isIsoDate(value: unknown): value is string {
  return isRealIsoDate(value);
}

export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

export function shiftIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function resolveTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_TIME_ZONE;
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Milliseconds since epoch, or null when the timestamp cannot be read. */
export function instant(value: unknown): number | null {
  if (value == null || value === "") return null;
  const text = String(value);
  const match = text.match(OFFSET_RE);
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  const offset = match[3] ? `${match[3]}:${match[4]}` : "Z";
  const parsed = new Date(`${match[1]}T${match[2]}${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}
