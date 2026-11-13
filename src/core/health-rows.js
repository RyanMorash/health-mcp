import { aggregateDays } from "./aggregate.js";

const ASLEEP_STAGES = new Set(["asleep", "core", "rem", "deep", "unspecified"]);

/** Rows whose stored signature already matches are not written again. */
export function rowsToWrite(existing, incoming) {
  const prev = new Map((existing || []).map((row) => [row.id, row.sig]));
  const write = [];
  for (const row of incoming || []) {
    if (!row?.id) continue;
    if (prev.get(row.id) === row.sig) continue;
    write.push(row);
  }
  return write;
}

/**
 * Daily rows from stored samples. Raw readings win over summarized buckets,
 * and summarized buckets win over a single all-day total, so a later raw
 * sync is not added on top of an older daily total.
 * Sleep segments count asleep stages. Awake and In Bed stay on the sleep rows.
 */
export function dailyFromSamples(samples) {
  const groups = new Map();
  for (const sample of samples || []) {
    if (!sample?.metric || !sample?.date) continue;
    const key = `${sample.metric}\0${sample.date}`;
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  const flat = [];
  for (const group of groups.values()) {
    let use = group;
    if (group.some((row) => row.grain === "reading")) use = group.filter((row) => row.grain === "reading");
    else if (group.some((row) => row.grain === "bucket")) use = group.filter((row) => row.grain === "bucket");
    if (use[0]?.metric === "sleep_analysis" && use.some((row) => row.value)) {
      const asleep = use.filter((row) => ASLEEP_STAGES.has(String(row.value).toLowerCase()));
      if (asleep.length) use = asleep;
    }
    use.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const row of use) {
      const qty = row.qty != null ? Number(row.qty) : row.avg_qty != null ? Number(row.avg_qty) : null;
      if (qty == null || !Number.isFinite(qty)) continue;
      flat.push({ metric: row.metric, date: row.date, ts: row.ts, qty, units: row.units ?? null });
    }
  }
  return aggregateDays(flat, null);
}

/** Replace daily rows for metrics this payload touched with totals from stored samples. */
export function pointsAfterSamples(points, incoming, storedSamples) {
  if (!incoming?.length) return points || [];
  const affected = new Set(incoming.map((row) => `${row.metric}\0${row.date}`));
  const relevant = (storedSamples || []).filter((row) => affected.has(`${row.metric}\0${row.date}`));
  const recomputed = dailyFromSamples(relevant);
  const map = new Map((points || []).map((point) => [`${point.date}\0${point.metric}`, point]));
  for (const point of recomputed) {
    const key = `${point.date}\0${point.metric}`;
    const prev = map.get(key);
    map.set(key, prev?.replace ? { ...point, replace: true } : point);
  }
  return [...map.values()];
}

export function uniqueDates(rows) {
  return [...new Set((rows || []).map((row) => row?.date).filter(Boolean))];
}
