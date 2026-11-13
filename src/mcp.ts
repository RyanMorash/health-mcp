import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { isRealIsoDate } from "./dates.js";
import { isSeriesKey } from "./id.js";
import { eventsInRange, listMetrics, metricRollup, readHint, readSeries, samplesForDay, workoutsForDay, workoutsInRange } from "./storage.js";
import { summarizeDay } from "./summary.js";
import type { EventKind } from "./types.js";

const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 500;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar day, YYYY-MM-DD.");

function rangeError(start: string, end: string): string | null {
  if (!isRealIsoDate(start) || !isRealIsoDate(end) || start > end) return "start_date and end_date must be real YYYY-MM-DD dates, with start_date first.";
  const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  if (span > MAX_RANGE_DAYS) return `The end date can be at most ${MAX_RANGE_DAYS} days after the start date.`;
  return null;
}

function toolResult(data: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(isError ? {} : { structuredContent: data as Record<string, unknown> }),
  };
}

function buildServer(env: Env) {
  const server = new McpServer({ name: "health-mcp", version: "1.0.0" });

  server.registerTool(
    "get_daily_summary",
    {
      description: "Nutrition, steps, energy, weight, body fat, sleep, and workouts for one calendar day. Same object as GET /summary.",
      inputSchema: z.object({ date: Day }),
      annotations: READ_ONLY,
    },
    async ({ date }) => {
      const [samples, workouts, hint] = await Promise.all([samplesForDay(env.DB, date), workoutsForDay(env.DB, date), readHint(env.DB)]);
      return toolResult(summarizeDay(date, samples, workouts, hint));
    },
  );

  server.registerTool(
    "list_metrics",
    {
      description: "Metric names that have stored samples, with the rollup kind for each.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => toolResult({ metrics: await listMetrics(env.DB) }),
  );

  server.registerTool(
    "query_metrics",
    {
      description: "Daily rollup for one metric. Sums are totals, latest metrics keep the last reading, and heart rate is min, average, and max. Heart rate is never summed.",
      inputSchema: z.object({
        metric: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/).describe("Metric name, such as step_count or heart_rate."),
        start_date: Day,
        end_date: Day,
      }),
      annotations: READ_ONLY,
    },
    async ({ metric, start_date, end_date }) => {
      const error = rangeError(start_date, end_date);
      if (error) return toolResult({ error }, true);
      const rolled = await metricRollup(env.DB, metric, start_date, end_date, MAX_ROWS);
      return toolResult({ metric, kind: rolled.kind, start_date, end_date, truncated: rolled.truncated, rows: rolled.rows });
    },
  );

  server.registerTool(
    "query_workouts",
    {
      description: "Workout summaries between two dates. Routes and time series are not included; use get_series with series_key for those.",
      inputSchema: z.object({ start_date: Day, end_date: Day }),
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date }) => {
      const error = rangeError(start_date, end_date);
      if (error) return toolResult({ error }, true);
      const workouts = await workoutsInRange(env.DB, start_date, end_date, MAX_ROWS + 1);
      const truncated = workouts.length > MAX_ROWS;
      return toolResult({
        start_date,
        end_date,
        truncated,
        workouts: workouts.slice(0, MAX_ROWS).map((workout) => ({
          id: workout.id,
          name: workout.name,
          start: workout.start_ts,
          end: workout.end_ts,
          date: workout.date,
          duration_min: workout.duration_s == null ? null : Math.round(workout.duration_s / 6) / 10,
          active_kcal: workout.active_kcal,
          total_kcal: workout.total_kcal,
          distance_qty: workout.distance_qty,
          distance_units: workout.distance_units,
          hr_min: workout.hr_min,
          hr_avg: workout.hr_avg,
          hr_max: workout.hr_max,
          location: workout.location,
          source: workout.source,
          series_key: workout.series_key,
        })),
      });
    },
  );

  server.registerTool(
    "query_events",
    {
      description: "Symptoms, cycle tracking, medications, state of mind, ECG metadata, or heart-rate notifications. ECG voltage is not inlined.",
      inputSchema: z.object({
        kind: z.enum(["symptom", "cycle", "medication", "state_of_mind", "ecg", "heart_rate_notification"]),
        start_date: Day,
        end_date: Day,
      }),
      annotations: READ_ONLY,
    },
    async ({ kind, start_date, end_date }) => {
      const error = rangeError(start_date, end_date);
      if (error) return toolResult({ error }, true);
      const events = await eventsInRange(env.DB, kind as EventKind, start_date, end_date, MAX_ROWS + 1);
      const truncated = events.length > MAX_ROWS;
      return toolResult({ kind, start_date, end_date, truncated, events: events.slice(0, MAX_ROWS) });
    },
  );

  server.registerTool(
    "get_series",
    {
      description: "One page of a workout route, workout time series, ECG voltage, or beat-to-beat reading stored in R2. Omit part to list the arrays in the object.",
      inputSchema: z.object({
        key: z.string().describe("series_key from a workout, event, or metric row."),
        part: z.string().optional().describe("Array name inside the object, such as route or voltageMeasurements."),
        offset: z.number().int().min(0).optional().describe("First item to return. Defaults to 0."),
      }),
      annotations: READ_ONLY,
    },
    async ({ key, part, offset }) => {
      if (!isSeriesKey(key)) return toolResult({ error: "unknown_series" }, true);
      const body = await readSeries(env.SERIES, key);
      if (body == null) return toolResult({ error: "unknown_series" }, true);
      const start = offset ?? 0;
      if (Array.isArray(body)) {
        const items = body.slice(start, start + MAX_ROWS);
        return toolResult({ key, offset: start, truncated: start + items.length < body.length, items });
      }
      if (body == null || typeof body !== "object") return toolResult({ key, value: body });
      const record = body as Record<string, unknown>;
      if (!part) {
        const parts = Object.entries(record).map(([name, value]) => ({ name, length: Array.isArray(value) ? value.length : null }));
        return toolResult({ key, parts });
      }
      const value = record[part];
      if (!Array.isArray(value)) return toolResult({ error: "unknown_part" }, true);
      const items = value.slice(start, start + MAX_ROWS);
      return toolResult({ key, part, offset: start, truncated: start + items.length < value.length, items });
    },
  );

  return server;
}

export function mcpHandler(env: Env) {
  return createMcpHandler(() => buildServer(env), { route: "/mcp" });
}
