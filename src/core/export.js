const DATASETS = new Set(["samples", "daily", "sleep", "workouts", "records"]);
const MAX_EXPORT_ROWS = 2000;

function csvCell(value) {
  if (value == null) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return `${lines.join("\n")}\n`;
}

function page(rows, offset, limit) {
  const slice = rows.slice(offset, offset + limit);
  const next = offset + slice.length < rows.length ? String(offset + slice.length) : null;
  return { rows: slice, next_cursor: next };
}

/**
 * One page of stored health data. `format` is `json` or `csv`.
 * The cursor is a row offset.
 */
export async function exportDataset(storage, {
  dataset = "daily",
  format = "json",
  metric = null,
  kind = null,
  start = "1970-01-01",
  end = "9999-12-31",
  cursor = "0",
  limit = 500,
} = {}) {
  if (!DATASETS.has(dataset)) {
    const error = new Error("dataset must be samples, daily, sleep, workouts, or records");
    error.code = "BAD_EXPORT";
    throw error;
  }
  const offset = Number(cursor || 0);
  if (!Number.isInteger(offset) || offset < 0) {
    const error = new Error("cursor must be a non-negative integer");
    error.code = "BAD_EXPORT";
    throw error;
  }
  const size = Math.min(Math.max(Number(limit) || 500, 1), MAX_EXPORT_ROWS);
  let rows = [];
  if (dataset === "samples") {
    if (!metric) {
      const error = new Error("metric is required for samples");
      error.code = "BAD_EXPORT";
      throw error;
    }
    rows = await storage.querySamples(String(metric).toLowerCase(), start, end, size + 1, offset);
  } else if (dataset === "daily") {
    const metricName = metric ? String(metric).toLowerCase() : "";
    rows = await storage.queryDailyPage(start, end, metricName, size + 1, offset);
  } else if (dataset === "sleep") {
    rows = await storage.querySleep(start, end, size + 1, offset);
  } else if (dataset === "workouts") {
    rows = await storage.queryWorkoutDetails(start, end, size + 1, offset);
  } else {
    if (!kind) {
      const error = new Error("kind is required for records");
      error.code = "BAD_EXPORT";
      throw error;
    }
    rows = await storage.queryRecords(kind, start, end, size + 1, offset);
  }
  const more = rows.length > size;
  const kept = more ? rows.slice(0, size) : rows;
  return finish(dataset, format, { rows: kept, next_cursor: more ? String(offset + size) : null });
}

function finish(dataset, format, paged) {
  const columns = paged.rows[0] ? Object.keys(paged.rows[0]).filter((key) => key !== "sig" && key !== "identity") : [];
  const body = {
    dataset,
    rows: paged.rows.map((row) => {
      const copy = { ...row };
      delete copy.sig;
      delete copy.identity;
      if (copy.payload && typeof copy.payload === "string") {
        try { copy.payload = JSON.parse(copy.payload); } catch { /* keep the string */ }
      }
      return copy;
    }),
    next_cursor: paged.next_cursor,
  };
  if (format === "csv") {
    return { ...body, csv: toCsv(body.rows, columns.length ? columns : ["date"]), format: "csv" };
  }
  return { ...body, format: "json" };
}
