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
    let sum = 0;
    let n = 0;
    let last = null;
    for (const row of use) {
      const qty = row.qty != null ? Number(row.qty) : row.avg_qty != null ? Number(row.avg_qty) : null;
      if (qty == null || !Number.isFinite(qty)) continue;
      sum += qty;
      n += 1;
      if (!last || String(row.ts) >= String(last.ts)) last = { ...row, qty };
    }
    if (!last) continue;
    flat.push({
      metric: use[0].metric,
      date: use[0].date,
      sum_qty: sum,
      last_qty: last.qty,
      last_ts: String(last.ts),
      units: last.units ?? null,
      n,
    });
  }
  flat.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
  return flat;
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
    // The rebuilt row is the source of truth, even when it has fewer samples
    // than the daily row already stored.
    map.set(key, { ...point, replace: true });
  }
  return [...map.values()];
}

const DETAIL_ARRAYS = new Set([
  "heartRateData",
  "heartRateRecovery",
  "route",
  "activeEnergy",
  "basalEnergy",
  "stepCount",
  "events",
  "segments",
  "laps",
  "activities",
  "splits",
]);

function parseDetail(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Keep route and series from an earlier export when this post left them out. */
export function mergeDetailJson(previous, incoming) {
  const oldDetail = parseDetail(previous);
  const nextDetail = parseDetail(incoming);
  if (!oldDetail || !nextDetail) return incoming ?? previous ?? null;
  const merged = { ...oldDetail };
  for (const [key, value] of Object.entries(nextDetail)) {
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0 && Array.isArray(oldDetail[key]) && oldDetail[key].length) continue;
    if (DETAIL_ARRAYS.has(key) && !Array.isArray(value)) {
      merged[key] = value;
      continue;
    }
    merged[key] = value;
  }
  return JSON.stringify(merged);
}

export function mergeWorkoutDetails(workouts, storedWorkouts) {
  const previous = new Map((storedWorkouts || []).map((workout) => [`${workout.name}\0${workout.start}`, workout]));
  return (workouts || []).map((workout) => {
    const stored = previous.get(`${workout.name}\0${workout.start}`);
    if (!stored?.detail || workout.detail == null) return workout;
    return { ...workout, detail: mergeDetailJson(stored.detail, workout.detail) };
  });
}

export function uniqueDates(rows) {
  return [...new Set((rows || []).map((row) => row?.date).filter(Boolean))];
}
