import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LATEST_METRICS, SUM_METRICS } from "./metrics.js";
import { summarizeDay } from "./summary.js";

/** Protocol versions this server can speak. Unknown requests fall back to 2025-06-18. */
export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** End date may be at most this many days after the start date. */
export const MAX_RANGE_DAYS = 366;

/** Most rows one tool call returns. Extra rows are dropped and `truncated` is set. */
export const MAX_TOOL_RESULTS = 500;

/** MCP request bodies above this are rejected. */
export const MAX_MCP_BYTES = 64 * 1024;

export const MCP_SERVER_NAME = "health-mcp";

const SUPPORTED = new Set(MCP_PROTOCOL_VERSIONS);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const METRIC_RE = /^[a-z][a-z0-9_]{0,127}$/;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const MCP_TOOLS = [
  {
    name: "get_daily_summary",
    description: "Daily summary for one calendar day of data exported from Apple Health: dietary and active calories, macros, steps, weight, body fat, and workouts. Same object as GET /summary. Includes export_hint when a recent phone export looks misconfigured.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Calendar day, YYYY-MM-DD." },
      },
      required: ["date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_metric",
    description: `Daily rows for one stored metric between two dates, inclusive. Each row is one calendar day with sum_qty, last_qty, last_ts, units, and n. The end date can be at most ${MAX_RANGE_DAYS} days after the start date, and at most ${MAX_TOOL_RESULTS} rows are returned.`,
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "Health Auto Export metric name, such as step_count." },
        start_date: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
        end_date: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
        granularity: { type: "string", description: "raw, day, week, or month. Defaults to day." },
        cursor: { type: "string", description: "Offset from a previous next_cursor." },
        limit: { type: "integer", description: `Page size, at most ${MAX_TOOL_RESULTS}.` },
      },
      required: ["metric", "start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_metrics",
    description: "Metric names that have at least one stored day, with the summary field each recognized metric fills.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "list_coverage",
    description: "Stored metrics, sleep, workouts, and other Health Auto Export data types, with the first date, last date, and row count for each.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "get_sleep",
    description: `Sleep nights and stage segments between two dates. Summaries include stage hours. The end date can be at most ${MAX_RANGE_DAYS} days after the start date. Results are paginated.`,
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
        end_date: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
        cursor: { type: "string", description: "Offset returned as next_cursor. Omit for the first page." },
        limit: { type: "integer", description: `Page size, at most ${MAX_TOOL_RESULTS}.` },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_records",
    description: `Symptoms, ECG, heart rate notifications, state of mind, cycle tracking, or medications between two dates. kind is one of symptoms, ecg, heart_rate_notifications, state_of_mind, cycle_tracking, medications.`,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        start_date: { type: "string" },
        end_date: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["kind", "start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_workout",
    description: `Workouts between two dates, including heart-rate series, route, and metadata when they were stored. Paginated.`,
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string" },
        end_date: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "summarize_dates",
    description: `Daily summaries for each day in a range, plus totals for summed metrics. The end date can be at most ${MAX_RANGE_DAYS} days after the start date.`,
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string" },
        end_date: { type: "string" },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "export_health",
    description: "One page of stored data. dataset is samples, daily, sleep, workouts, or records. samples requires metric. records requires kind. format is json or csv.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        format: { type: "string" },
        metric: { type: "string" },
        kind: { type: "string" },
        start_date: { type: "string" },
        end_date: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["dataset"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_workouts",
    description: `Workouts whose calendar date falls between two dates, inclusive. The end date can be at most ${MAX_RANGE_DAYS} days after the start date, and at most ${MAX_TOOL_RESULTS} workouts are returned.`,
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
        end_date: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

class ToolInputError extends Error {}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseStoredJson(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireDate(value, label) {
  if (!isIsoDate(value)) throw new ToolInputError(`${label} must be YYYY-MM-DD`);
}

function dateRange(start, end) {
  requireDate(start, "start_date");
  requireDate(end, "end_date");
  if (start > end) throw new ToolInputError("start_date must be on or before end_date");
  const span = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  if (span > MAX_RANGE_DAYS) throw new ToolInputError(`date range must be ${MAX_RANGE_DAYS} days or fewer`);
}

function metricName(value) {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!METRIC_RE.test(name)) throw new ToolInputError("metric must be a Health Auto Export name such as step_count");
  return name;
}

const RECORD_KINDS = new Set([
  "symptoms",
  "ecg",
  "heart_rate_notifications",
  "state_of_mind",
  "cycle_tracking",
  "medications",
]);

function pageArgs(args) {
  const limit = args.limit == null ? MAX_TOOL_RESULTS : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOOL_RESULTS) {
    throw new ToolInputError(`limit must be an integer from 1 to ${MAX_TOOL_RESULTS}`);
  }
  const offset = args.cursor == null || args.cursor === "" ? 0 : Number(args.cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new ToolInputError("cursor must be a non-negative integer");
  return { limit, offset };
}

function bucketDate(date, granularity) {
  if (granularity === "month") return date.slice(0, 7);
  if (granularity === "week") {
    const utc = Date.parse(`${date}T00:00:00Z`);
    const day = new Date(utc).getUTCDay();
    const monday = new Date(utc - ((day + 6) % 7) * 86400000);
    return monday.toISOString().slice(0, 10);
  }
  return date;
}

function rollup(rows, granularity) {
  const groups = new Map();
  for (const row of rows) {
    const key = bucketDate(row.date, granularity);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([date, group]) => {
    let sum = 0;
    let min = null;
    let max = null;
    let n = 0;
    let last = group[0];
    for (const row of group) {
      const qty = asNumber(row.sum_qty ?? row.qty);
      if (qty != null) {
        sum += qty;
        n += Number(row.n || 1);
        min = min == null ? qty : Math.min(min, qty);
        max = max == null ? qty : Math.max(max, qty);
      }
      if (String(row.last_ts || row.ts || "") >= String(last.last_ts || last.ts || "")) last = row;
    }
    return {
      date,
      sum_qty: sum,
      avg_qty: n ? sum / n : null,
      min_qty: min,
      max_qty: max,
      last_qty: asNumber(last.last_qty ?? last.qty),
      last_ts: last.last_ts ?? last.ts ?? null,
      units: last.units ?? null,
      n,
    };
  });
}

function argumentsOf(params) {
  if (params == null || params.arguments == null) return {};
  if (!isPlainObject(params.arguments)) throw new ToolInputError("arguments must be an object");
  return params.arguments;
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolOk(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function summaryField(name) {
  return SUM_METRICS[name] || LATEST_METRICS[name] || null;
}

async function runTool(name, args, storage) {
  if (name === "get_daily_summary") {
    requireDate(args.date, "date");
    return storage.queryDaySummary(args.date);
  }
  if (name === "get_metric") {
    const metric = metricName(args.metric);
    dateRange(args.start_date, args.end_date);
    const granularity = args.granularity == null || args.granularity === "" ? "day" : String(args.granularity);
    if (!["raw", "day", "week", "month"].includes(granularity)) {
      throw new ToolInputError("granularity must be raw, day, week, or month");
    }
    if (granularity === "raw") {
      const { limit, offset } = pageArgs(args);
      const fetched = await storage.querySamples(metric, args.start_date, args.end_date, limit + 1, offset);
      const more = fetched.length > limit;
      const rows = (more ? fetched.slice(0, limit) : fetched).map((row) => ({
        id: row.id,
        date: row.date,
        ts: row.ts,
        end_ts: row.end_ts ?? null,
        qty: asNumber(row.qty),
        min_qty: asNumber(row.min_qty),
        max_qty: asNumber(row.max_qty),
        avg_qty: asNumber(row.avg_qty),
        units: row.units ?? null,
        source: row.source ?? null,
        value: row.value ?? null,
        extra: row.extra ?? null,
      }));
      return {
        metric,
        start_date: args.start_date,
        end_date: args.end_date,
        granularity,
        truncated: more,
        next_cursor: more ? String(offset + limit) : null,
        rows,
      };
    }
    const daily = await storage.queryMetricRange(metric, args.start_date, args.end_date);
    const rolled = granularity === "day" ? daily : rollup(daily, granularity);
    const paged = granularity === "day" && args.cursor == null && args.limit == null;
    if (paged) {
      return {
        metric,
        start_date: args.start_date,
        end_date: args.end_date,
        granularity,
        truncated: rolled.length > MAX_TOOL_RESULTS,
        rows: rolled.slice(0, MAX_TOOL_RESULTS).map((row) => ({
          date: row.date,
          sum_qty: asNumber(row.sum_qty),
          last_qty: asNumber(row.last_qty),
          last_ts: row.last_ts ?? null,
          units: row.units ?? null,
          n: asNumber(row.n),
        })),
      };
    }
    const { limit, offset } = pageArgs(args);
    const rows = rolled.slice(offset, offset + limit);
    return {
      metric,
      start_date: args.start_date,
      end_date: args.end_date,
      granularity,
      truncated: offset + rows.length < rolled.length,
      next_cursor: offset + rows.length < rolled.length ? String(offset + rows.length) : null,
      rows: rows.map((row) => ({
        date: row.date,
        sum_qty: asNumber(row.sum_qty),
        avg_qty: asNumber(row.avg_qty),
        min_qty: asNumber(row.min_qty),
        max_qty: asNumber(row.max_qty),
        last_qty: asNumber(row.last_qty),
        last_ts: row.last_ts ?? null,
        units: row.units ?? null,
        n: asNumber(row.n),
      })),
    };
  }
  if (name === "list_metrics") {
    const names = await storage.listMetrics();
    return {
      metrics: [...new Set(names)].sort().map((entry) => ({
        name: entry,
        summary_field: summaryField(entry),
      })),
    };
  }
  if (name === "list_coverage") {
    const rows = await storage.listCoverage();
    return { coverage: rows };
  }
  if (name === "get_sleep") {
    dateRange(args.start_date, args.end_date);
    const { limit, offset } = pageArgs(args);
    const fetched = await storage.querySleep(args.start_date, args.end_date, limit + 1, offset);
    const more = fetched.length > limit;
    return {
      start_date: args.start_date,
      end_date: args.end_date,
      truncated: more,
      next_cursor: more ? String(offset + limit) : null,
      sessions: (more ? fetched.slice(0, limit) : fetched).map((row) => ({
        id: row.id,
        date: row.date,
        kind: row.kind,
        start: row.start_ts ?? null,
        end: row.end_ts ?? null,
        in_bed_start: row.in_bed_start ?? null,
        in_bed_end: row.in_bed_end ?? null,
        total_hr: asNumber(row.total_hr),
        asleep_hr: asNumber(row.asleep_hr),
        in_bed_hr: asNumber(row.in_bed_hr),
        core_hr: asNumber(row.core_hr),
        deep_hr: asNumber(row.deep_hr),
        rem_hr: asNumber(row.rem_hr),
        awake_hr: asNumber(row.awake_hr),
        stage: row.stage ?? null,
        source: row.source ?? null,
      })),
    };
  }
  if (name === "get_records") {
    const kind = typeof args.kind === "string" ? args.kind.trim() : "";
    if (!RECORD_KINDS.has(kind)) throw new ToolInputError("kind must be a Health Auto Export data type such as symptoms");
    dateRange(args.start_date, args.end_date);
    const { limit, offset } = pageArgs(args);
    const fetched = await storage.queryRecords(kind, args.start_date, args.end_date, limit + 1, offset);
    const more = fetched.length > limit;
    return {
      kind,
      start_date: args.start_date,
      end_date: args.end_date,
      truncated: more,
      next_cursor: more ? String(offset + limit) : null,
      records: (more ? fetched.slice(0, limit) : fetched).map((row) => ({
        id: row.id,
        date: row.date,
        ts: row.ts ?? null,
        name: row.name ?? null,
        source: row.source ?? null,
        payload: parseStoredJson(row.payload),
      })),
    };
  }
  if (name === "get_workout") {
    dateRange(args.start_date, args.end_date);
    const { limit, offset } = pageArgs(args);
    const fetched = await storage.queryWorkoutDetails(args.start_date, args.end_date, limit + 1, offset);
    const more = fetched.length > limit;
    return {
      start_date: args.start_date,
      end_date: args.end_date,
      truncated: more,
      next_cursor: more ? String(offset + limit) : null,
      workouts: (more ? fetched.slice(0, limit) : fetched).map((workout) => ({
        name: workout.name,
        start: workout.start,
        end: workout.end_ts ?? null,
        date: workout.date,
        duration_min: asNumber(workout.duration_min),
        kcal: asNumber(workout.kcal),
        source: workout.source ?? null,
        detail: parseStoredJson(workout.detail),
      })),
    };
  }
  if (name === "summarize_dates") {
    dateRange(args.start_date, args.end_date);
    const points = await storage.queryPointsBetween(args.start_date, args.end_date);
    const workouts = await storage.listWorkouts(args.start_date, args.end_date);
    const days = [...new Set([...points.map((point) => point.date), ...workouts.map((workout) => workout.date)])].sort();
    const summaries = days.map((date) => summarizeDay(
      date,
      points.filter((point) => point.date === date),
      workouts.filter((workout) => workout.date === date),
    ));
    const totals = { days: summaries.length };
    for (const field of ["dietary_kcal", "protein_g", "carbs_g", "fat_g", "active_kcal", "basal_kcal", "steps"]) {
      const values = summaries.map((day) => day[field]).filter((value) => value != null);
      totals[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    }
    return { start_date: args.start_date, end_date: args.end_date, totals, days: summaries };
  }
  if (name === "export_health") {
    const { exportDataset } = await import("./export.js");
    try {
      return await exportDataset(storage, {
        dataset: args.dataset,
        format: args.format || "json",
        metric: args.metric || null,
        kind: args.kind || null,
        start: args.start_date || "1970-01-01",
        end: args.end_date || "9999-12-31",
        cursor: args.cursor || "0",
        limit: args.limit == null ? MAX_TOOL_RESULTS : args.limit,
      });
    } catch (error) {
      if (error?.code === "BAD_EXPORT") throw new ToolInputError(error.message);
      throw error;
    }
  }
  if (name === "list_workouts") {
    dateRange(args.start_date, args.end_date);
    const workouts = await storage.listWorkouts(args.start_date, args.end_date);
    return {
      start_date: args.start_date,
      end_date: args.end_date,
      truncated: workouts.length > MAX_TOOL_RESULTS,
      workouts: workouts.slice(0, MAX_TOOL_RESULTS).map((workout) => ({
        name: workout.name,
        start: workout.start,
        date: workout.date,
        duration_min: asNumber(workout.duration_min),
        kcal: asNumber(workout.kcal),
      })),
    };
  }
  return null;
}

function createHealthServer(storage) {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: "0.2.0",
    instructions: "Read-only health data. Dates are calendar days in YYYY-MM-DD. This server has no write tools.",
  });
  for (const tool of MCP_TOOLS) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: z.any(),
      annotations: tool.annotations,
    }, async (args) => {
      try {
        const value = await runTool(tool.name, argumentsOf({ arguments: args }), storage);
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        };
      } catch (error) {
        if (error instanceof ToolInputError) return toolError(error.message);
        throw error;
      }
    });
  }
  return server;
}

function rpcError(code, message, status = 400) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function normalizeOrigin(value) {
  return String(value).trim().replace(/\/+$/, "").toLowerCase();
}

/** Comma-separated Origin values. Empty means no browser origin is allowed. */
export function parseOriginAllowlist(value) {
  if (value == null || value === false) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map(normalizeOrigin).filter(Boolean);
}

/** A missing Origin is allowed. A present Origin must be on the allowlist. */
export function originAllowed(origin, allowlist) {
  if (origin == null || String(origin).trim() === "") return true;
  return new Set(parseOriginAllowlist(allowlist)).has(normalizeOrigin(origin));
}

function tooLarge() {
  return new Response(JSON.stringify({ error: "payload_too_large" }), {
    status: 413,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Byte size from `Content-Length`, or null when the header is missing or not an integer. */
export function declaredContentLength(header) {
  if (header == null) return null;
  const value = String(header).trim();
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Read a request body in chunks and stop once it passes `limit` bytes.
 * Cancels the stream instead of buffering the rest.
 */
export async function readLimitedText(req, limit) {
  if (req.body == null) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        const error = new Error("payload_too_large");
        error.code = "PAYLOAD_TOO_LARGE";
        throw error;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  reader.releaseLock();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Streamable HTTP MCP endpoint. Stateless `createMcpHandler` builds a fresh
 * server per request, so no Durable Object session is required. Bearer auth
 * is enforced by `handleRequest` before this runs. This function never writes.
 * @param {Request} req
 * @param {{ mcpAllowedOrigins?: string | string[], storage: object }} ctx
 */
export async function handleMcp(req, ctx) {
  if (!originAllowed(req.headers.get("origin"), ctx.mcpAllowedOrigins)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > MAX_MCP_BYTES) return tooLarge();
  const version = req.headers.get("mcp-protocol-version");
  if (version && !SUPPORTED.has(version)) return rpcError(-32600, "unsupported protocol version");

  const accept = req.headers.get("accept");
  const acceptsResponse = !accept || accept.includes("*/*") || accept.includes("application/json") || accept.includes("text/event-stream");
  if (!acceptsResponse) {
    return new Response(JSON.stringify({ error: "not_acceptable" }), {
      status: 406,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  let text;
  try {
    text = await readLimitedText(req, MAX_MCP_BYTES);
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return tooLarge();
    throw error;
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(-32700, "parse error");
  }
  if (!isPlainObject(message) || message.jsonrpc !== "2.0") return rpcError(-32600, "invalid request");

  const headers = new Headers(req.headers);
  if (!headers.has("host")) headers.set("host", new URL(req.url).host);
  const offered = accept || "";
  const acceptsJson = offered.includes("application/json") || offered.includes("*/*");
  const acceptsSse = offered.includes("text/event-stream") || offered.includes("*/*");
  if (!offered || acceptsJson || acceptsSse) headers.set("accept", "application/json, text/event-stream");
  const forwarded = new Request(req.url, { method: req.method, headers });
  const handler = createMcpHandler(() => createHealthServer(ctx.storage), {
    route: "/mcp",
    corsOptions: false,
    allowedOriginHostnames: "*",
  });
  const response = await handler.fetch(forwarded, { parsedBody: message });
  const streamOnly = Boolean(accept) && accept.includes("text/event-stream") && !accept.includes("application/json") && !accept.includes("*/*");
  if (streamOnly) return response;
  return jsonFromEventStream(response);
}

/** Legacy JSON-RPC responses from the Agents handler are SSE. Clients that accept JSON get one JSON body. */
async function jsonFromEventStream(response) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) return response;
  const text = await response.text();
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).pop();
  return new Response(data || text, {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
