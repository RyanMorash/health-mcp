import { authed, unauthorized } from "./auth.js";
import { isRealIsoDate } from "./dates.js";
import { d1DailyLimitKind, dailyLimitResponse } from "./free-tier.js";
import { isSeriesKey, recordId } from "./id.js";
import {
  chunkHint,
  distinctDates,
  exportHint,
  filterNormalized,
  INITIAL_IMPORT_CLOSED,
  MAX_INGEST_DATES,
  secondsUntilNextHour,
  settingsFromEnv,
  STALE_HINT_AT,
  type Settings,
} from "./limits.js";
import { mcpHandler } from "./mcp.js";
import { parseHealthAutoExport } from "./parse/hae.js";
import { loadIngestState, putSeries, readHint, samplesForDay, saveIngest, workoutsForDay, type IngestState } from "./storage.js";
import { summarizeDay } from "./summary.js";
import { emptyNormalized, type EventKind, type HealthEvent, type MetricKind, type Normalized, type Sample, type Workout } from "./types.js";

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  return Response.json(body, { status, headers });
}

function backfillBody(state: IngestState) {
  return { open: state.view.open, closes_at: state.view.closes_at, bytes_remaining: state.view.bytes_remaining };
}

function withBackfill(body: Record<string, unknown>, state: IngestState, status: number): Response {
  return json({ ...body, backfill: backfillBody(state) }, status);
}

function rejectIngest(reason: "rate_limited" | "over_budget", state: IngestState, now: Date): Response {
  if (reason === "over_budget") {
    return withBackfill(
      { error: "payload_too_large", message: `This chunk would pass the initial import total. ${chunkHint(state.byteLimit)}` },
      state,
      413,
    );
  }
  return json(
    { error: "rate_limited", message: `Too many ingest posts for this token. The limit is ${state.rateLimit} per hour.`, backfill: backfillBody(state) },
    429,
    { "retry-after": String(secondsUntilNextHour(now)) },
  );
}

async function readLimited(req: Request, limit: number): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      const error = new Error("PAYLOAD_TOO_LARGE");
      (error as { code?: string }).code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function doneRequest(req: Request, body: unknown): boolean {
  if ((req.headers.get("x-backfill") || "").trim().toLowerCase() === "done") return true;
  return isObject(body) && body.backfill === "done" && Object.keys(body).every((key) => key === "backfill");
}

function wantsClose(req: Request, body: unknown): boolean {
  if ((req.headers.get("x-backfill") || "").trim().toLowerCase() === "done") return true;
  return isObject(body) && body.backfill === "done";
}

async function ingest(req: Request, env: Env, settings: Settings, now: Date): Promise<Response> {
  const state = await loadIngestState(env.DB, settings, now);
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > state.byteLimit) {
    const during = state.view.open || state.view.pending;
    return withBackfill(
      {
        error: "payload_too_large",
        message: during
          ? `Body exceeds ${state.byteLimit} bytes. Send a shorter date range. ${chunkHint(settings.backfill.maxBytes)}`
          : `Body exceeds ${state.byteLimit} bytes. ${INITIAL_IMPORT_CLOSED} Send a shorter range, such as today and yesterday.`,
      },
      state,
      413,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(req, state.byteLimit);
  } catch (error) {
    if ((error as { code?: string }).code === "PAYLOAD_TOO_LARGE") {
      return withBackfill(
        { error: "payload_too_large", message: `Body exceeds ${state.byteLimit} bytes. Send a shorter date range.` },
        state,
        413,
      );
    }
    throw error;
  }
  const type = (req.headers.get("content-type") || "").toLowerCase();
  if (type.includes("csv") || type.includes("markdown")) {
    return withBackfill({ error: "unsupported_media_type", message: "Send Health Auto Export JSON, version 2." }, state, 415);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return withBackfill({ error: "invalid_json" }, state, 400);
  }
  if (doneRequest(req, body)) {
    if (!state.view.open && !state.view.pending) return withBackfill({ ok: true, samples: 0, workouts: 0, events: 0, dates: [] }, state, 200);
    const saved = await saveIngest(env.DB, {
      normalized: emptyNormalized(),
      bytes: bytes.byteLength,
      charge: false,
      close: true,
      countPost: true,
      hint: undefined,
      now,
      settings,
      state,
    });
    if (!saved.ok) return rejectIngest(saved.reason, saved.state, now);
    return withBackfill({ ok: true, samples: 0, workouts: 0, events: 0, dates: [] }, saved.state, 200);
  }
  const parsed = await parseHealthAutoExport(body, settings.timeZone);
  if (parsed.error) return withBackfill({ error: parsed.error }, state, 400);
  if (distinctDates(parsed.normalized).length > MAX_INGEST_DATES) {
    return withBackfill(
      {
        error: "payload_too_large",
        message: `This request covers more than ${MAX_INGEST_DATES} dates. Send it in chunks of ${MAX_INGEST_DATES} dates or fewer. ${chunkHint(settings.backfill.maxBytes)}`,
      },
      state,
      413,
    );
  }
  const keepPast = state.view.open || state.view.pending;
  const filtered = filterNormalized(parsed.normalized, {
    now,
    timeZone: settings.timeZone,
    maxAgeDays: settings.maxAgeDays,
    keepPast,
    minDate: settings.minDate,
  });
  const kept = filtered.normalized.samples.length + filtered.normalized.workouts.length + filtered.normalized.events.length;
  if (!kept && (filtered.droppedStale || filtered.droppedEarly || filtered.droppedFuture)) {
    const message = filtered.droppedEarly
      ? `Dates before ${settings.minDate} are not accepted.`
      : `${INITIAL_IMPORT_CLOSED} Send today and yesterday.`;
    return withBackfill({ error: "outside_window", message, ...dropCounts(filtered) }, state, 422);
  }
  if (!kept) {
    return withBackfill({ ok: true, samples: 0, workouts: 0, events: 0, dates: [], ...dropCounts(filtered) }, state, 200);
  }
  if (keepPast && bytes.byteLength > state.admitRemaining) {
    return withBackfill(
      { error: "payload_too_large", message: `This chunk would pass the initial import total. ${chunkHint(settings.backfill.maxBytes)}` },
      state,
      413,
    );
  }
  if (state.rateLimit > 0 && state.posts >= state.rateLimit) {
    return json(
      { error: "rate_limited", message: `Too many ingest posts for this token. The limit is ${state.rateLimit} per hour.`, backfill: backfillBody(state) },
      429,
      { "retry-after": String(secondsUntilNextHour(now)) },
    );
  }
  const hint = filtered.droppedStale >= STALE_HINT_AT ? exportHint(settings.backfill.maxBytes) : kept ? null : undefined;
  const saved = await saveIngest(env.DB, {
    normalized: filtered.normalized,
    bytes: bytes.byteLength,
    charge: keepPast,
    close: wantsClose(req, body),
    countPost: true,
    hint,
    now,
    settings,
    state,
  });
  if (!saved.ok) return rejectIngest(saved.reason, saved.state, now);
  await putSeries(env.SERIES, filtered.normalized);
  return withBackfill(
    {
      ok: true,
      samples: filtered.normalized.samples.length,
      workouts: filtered.normalized.workouts.length,
      events: filtered.normalized.events.length,
      dates: distinctDates(filtered.normalized),
      ...dropCounts(filtered),
    },
    saved.state,
    200,
  );
}

function dropCounts(filtered: { droppedStale: number; droppedFuture: number; droppedEarly: number }) {
  return { dropped_stale: filtered.droppedStale, dropped_future: filtered.droppedFuture, dropped_early: filtered.droppedEarly };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function normalizeChunk(body: unknown): Promise<Normalized | string> {
  if (!isObject(body)) return "invalid_payload";
  const samplesIn = Array.isArray(body.samples) ? body.samples : null;
  const workoutsIn = Array.isArray(body.workouts) ? body.workouts : null;
  const eventsIn = Array.isArray(body.events) ? body.events : null;
  const seriesIn = Array.isArray(body.series) ? body.series : [];
  if (!samplesIn || !workoutsIn || !eventsIn) return "invalid_payload";
  if (samplesIn.length + workoutsIn.length + eventsIn.length > 20_000) return "payload_too_large";
  const normalized = emptyNormalized();
  for (const raw of samplesIn) {
    if (!isObject(raw) || !text(raw.metric) || !isRealIsoDate(raw.date) || !text(raw.start_ts) || !text(raw.kind)) return "invalid_payload";
    const sample: Sample = {
      id: text(raw.id) || "",
      metric: String(raw.metric),
      date: String(raw.date),
      start_ts: String(raw.start_ts),
      end_ts: text(raw.end_ts),
      source: typeof raw.source === "string" ? raw.source : "",
      qty: num(raw.qty),
      qty_min: num(raw.qty_min),
      qty_avg: num(raw.qty_avg),
      qty_max: num(raw.qty_max),
      units: text(raw.units),
      label: text(raw.label),
      extra: isObject(raw.extra) ? raw.extra : null,
      kind: String(raw.kind) as MetricKind,
      series_key: text(raw.series_key),
    };
    if (!sample.id) sample.id = await recordId(["chunk-sample", sample.metric, sample.date, sample.start_ts, sample.source, sample.label]);
    if (sample.series_key && !isSeriesKey(sample.series_key)) return "invalid_payload";
    normalized.samples.push(sample);
  }
  for (const raw of workoutsIn) {
    if (!isObject(raw) || !text(raw.name) || !text(raw.start_ts) || !isRealIsoDate(raw.date)) return "invalid_payload";
    const workout: Workout = {
      id: text(raw.id) || "",
      name: String(raw.name),
      start_ts: String(raw.start_ts),
      end_ts: text(raw.end_ts),
      date: String(raw.date),
      duration_s: num(raw.duration_s),
      active_kcal: num(raw.active_kcal),
      total_kcal: num(raw.total_kcal),
      distance_qty: num(raw.distance_qty),
      distance_units: text(raw.distance_units),
      hr_min: num(raw.hr_min),
      hr_avg: num(raw.hr_avg),
      hr_max: num(raw.hr_max),
      location: text(raw.location),
      source: text(raw.source),
      summary: isObject(raw.summary) ? raw.summary : null,
      series_key: text(raw.series_key),
    };
    if (!workout.id) workout.id = await recordId(["chunk-workout", workout.name, workout.start_ts]);
    if (workout.series_key && !isSeriesKey(workout.series_key)) return "invalid_payload";
    normalized.workouts.push(workout);
  }
  for (const raw of eventsIn) {
    if (!isObject(raw) || !text(raw.kind) || !text(raw.start_ts) || !isRealIsoDate(raw.date) || !isObject(raw.payload)) return "invalid_payload";
    const event: HealthEvent = {
      id: text(raw.id) || "",
      kind: String(raw.kind) as EventKind,
      subtype: text(raw.subtype),
      start_ts: String(raw.start_ts),
      end_ts: text(raw.end_ts),
      date: String(raw.date),
      source: text(raw.source),
      payload: raw.payload,
      series_key: text(raw.series_key),
    };
    if (!event.id) event.id = await recordId(["chunk-event", event.kind, event.subtype, event.start_ts]);
    if (event.series_key && !isSeriesKey(event.series_key)) return "invalid_payload";
    normalized.events.push(event);
  }
  for (const raw of seriesIn) {
    if (!isObject(raw) || !isSeriesKey(raw.key)) return "invalid_payload";
    normalized.series.push({ key: String(raw.key), body: raw.body });
  }
  return normalized;
}

async function importChunk(req: Request, env: Env, settings: Settings, now: Date): Promise<Response> {
  const limit = settings.backfill.maxBytes;
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(req, limit);
  } catch (error) {
    if ((error as { code?: string }).code === "PAYLOAD_TOO_LARGE") {
      return json({ error: "payload_too_large", message: `Body exceeds ${limit} bytes. ${chunkHint(limit)}` }, 413);
    }
    throw error;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const normalized = await normalizeChunk(body);
  if (typeof normalized === "string") {
    if (normalized === "payload_too_large") return json({ error: "payload_too_large", message: chunkHint(limit) }, 413);
    return json({ error: "invalid_payload" }, 400);
  }
  if (distinctDates(normalized).length > MAX_INGEST_DATES) {
    return json({ error: "payload_too_large", message: `Send at most ${MAX_INGEST_DATES} dates in one chunk.` }, 413);
  }
  const filtered = filterNormalized(normalized, { now, timeZone: settings.timeZone, maxAgeDays: settings.maxAgeDays, keepPast: true, minDate: settings.minDate });
  const state = await loadIngestState(env.DB, settings, now);
  if (!filtered.normalized.samples.length && !filtered.normalized.workouts.length && !filtered.normalized.events.length && filtered.droppedEarly) {
    return json({ error: "outside_window", message: `Dates before ${settings.minDate} are not accepted.` }, 422);
  }
  await putSeries(env.SERIES, filtered.normalized);
  await saveIngest(env.DB, {
    normalized: filtered.normalized,
    bytes: bytes.byteLength,
    charge: false,
    close: false,
    countPost: false,
    hint: undefined,
    now,
    settings,
    state,
    replaceAppleDates: distinctDates(filtered.normalized),
  });
  return json({
    ok: true,
    samples: filtered.normalized.samples.length,
    workouts: filtered.normalized.workouts.length,
    events: filtered.normalized.events.length,
    dates: distinctDates(filtered.normalized),
    dropped_early: filtered.droppedEarly,
    dropped_future: filtered.droppedFuture,
  });
}

function originAllowed(req: Request, allowed: string[]): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  return allowed.includes(origin);
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const settings = settingsFromEnv(env);
  const now = new Date();
  if (url.pathname === "/mcp") {
    if (!authed(request, settings.token)) return unauthorized();
    if (!originAllowed(request, settings.allowedOrigins)) return json({ error: "origin_not_allowed" }, 403);
    return mcpHandler(env)(request, env, ctx);
  }
  if (!authed(request, settings.token)) return unauthorized();
  if (url.pathname === "/ingest" && request.method === "POST") return ingest(request, env, settings, now);
  if (url.pathname === "/import/apple-health/chunk" && request.method === "POST") return importChunk(request, env, settings, now);
  if (url.pathname === "/summary" && request.method === "GET") {
    const date = url.searchParams.get("date") || "";
    if (!isRealIsoDate(date)) return json({ error: "invalid_date" }, 400);
    const [samples, workouts, hint] = await Promise.all([samplesForDay(env.DB, date), workoutsForDay(env.DB, date), readHint(env.DB)]);
    return json(summarizeDay(date, samples, workouts, hint));
  }
  return json({ error: "not_found" }, 404);
}

export async function handleSafely(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await handle(request, env, ctx);
  } catch (error) {
    const limit = d1DailyLimitKind(error);
    if (limit) return dailyLimitResponse(limit);
    console.log(JSON.stringify({ error: error instanceof Error ? error.name : "unknown" }));
    return json({ error: "internal" }, 500);
  }
}
