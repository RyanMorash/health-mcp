import {
  COVERAGE_METRICS,
  COVERAGE_RECORDS,
  COVERAGE_SLEEP,
  COVERAGE_WORKOUTS,
  POINTS_BETWEEN_DATES,
  RECORDS_RANGE,
  SAMPLES_RANGE,
  SLEEP_RANGE,
  WORKOUT_DETAILS_RANGE,
} from "./statements.js";

function kept(rows) {
  return (rows || []).filter((row) => Number(row?.n) > 0 && row.min_date);
}

/** Read methods shared by SQLite, D1, and Postgres. `query` returns row objects. */
export function bindHealthReads(query) {
  return {
    async querySamples(metric, start, end, limit, offset) {
      return query(SAMPLES_RANGE, metric, start, end, limit, offset);
    },
    async querySleep(start, end, limit, offset) {
      return query(SLEEP_RANGE, start, end, limit, offset);
    },
    async queryRecords(kind, start, end, limit, offset) {
      return query(RECORDS_RANGE, kind, start, end, limit, offset);
    },
    async queryWorkoutDetails(start, end, limit, offset) {
      return query(WORKOUT_DETAILS_RANGE, start, end, limit, offset);
    },
    async queryPointsBetween(start, end) {
      return query(POINTS_BETWEEN_DATES, start, end);
    },
    async listCoverage() {
      const [metrics, sleep, workouts, records] = await Promise.all([
        query(COVERAGE_METRICS),
        query(COVERAGE_SLEEP),
        query(COVERAGE_WORKOUTS),
        query(COVERAGE_RECORDS),
      ]);
      return [...kept(metrics), ...kept(sleep), ...kept(workouts), ...kept(records)];
    },
  };
}
