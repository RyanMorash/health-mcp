import { describe, expect, it } from "vitest";
import { chunkNormalized, parseAppleExport } from "../src/parse/apple.js";
import type { SampleRow } from "../src/storage.js";
import { rollupMetric } from "../src/summary.js";
import type { HealthEvent, Normalized, Sample, Workout } from "../src/types.js";

function appleExport(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2026-11-12 08:00:00 -0500"/>
  ${body}
</HealthData>`;
}

function sleepRecord(source: string, value: string, start: string, end: string): string {
  return `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${source}" value="${value}" startDate="${start}" endDate="${end}"/>`;
}

function stepRecord(source: string, value: number, start: string, end: string): string {
  return `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${source}" unit="count" value="${value}" startDate="${start}" endDate="${end}"/>`;
}

describe("sleep source selection", () => {
  it("keeps Clock when it is the only source with an asleep stage", async () => {
    const watchInBed = sleepRecord(
      "Apple Watch",
      "HKCategoryValueSleepAnalysisInBed",
      "2026-11-09 20:00:00 -0500",
      "2026-11-10 10:00:00 -0500",
    );
    const stages = [
      ["HKCategoryValueSleepAnalysisAsleepCore", "Core"],
      ["HKCategoryValueSleepAnalysisAsleepDeep", "Deep"],
      ["HKCategoryValueSleepAnalysisAsleepREM", "REM"],
      ["HKCategoryValueSleepAnalysisAsleep", "Asleep"],
    ] as const;
    for (const [value, label] of stages) {
      const parsed = await parseAppleExport(
        appleExport(
          `${watchInBed}
  ${sleepRecord("Clock", value, "2026-11-09 23:30:00 -0500", "2026-11-10 05:30:00 -0500")}`,
        ),
        { timeZone: "America/New_York" },
      );
      const sleep = parsed.samples.filter((sample) => sample.metric === "sleep_analysis");
      expect(sleep).toEqual([expect.objectContaining({ source: "Clock", label, date: "2026-11-10", qty: 6 })]);
    }
  });

  it("keeps Clock when priority lists it ahead of Apple Watch and both are asleep", async () => {
    const parsed = await parseAppleExport(
      appleExport(`${sleepRecord("Apple Watch", "HKCategoryValueSleepAnalysisAsleepDeep", "2026-11-11 00:00:00 -0500", "2026-11-11 05:00:00 -0500")}
  ${sleepRecord("Clock", "HKCategoryValueSleepAnalysisAsleepCore", "2026-11-10 23:00:00 -0500", "2026-11-11 00:00:00 -0500")}`),
      { timeZone: "America/New_York", sourcePriority: "Clock, Apple Watch" },
    );
    const sleep = parsed.samples.filter((sample) => sample.metric === "sleep_analysis");
    expect(sleep).toEqual([expect.objectContaining({ source: "Clock", label: "Core", date: "2026-11-11", qty: 1 })]);
  });
});

describe("instantaneous step samples", () => {
  it("counts two iPhone points at the same instant once", async () => {
    const parsed = await parseAppleExport(
      appleExport(`${stepRecord("Ryan's iPhone 13 Pro", 15, "2026-11-10 10:00:00 -0500", "2026-11-10 10:00:00 -0500")}
  ${stepRecord("Ryan's iPhone", 20, "2026-11-10 10:00:00 -0500", "2026-11-10 10:00:00 -0500")}`),
      { timeZone: "America/New_York", sourcePriority: "Apple Watch,iPhone" },
    );
    const steps = parsed.samples.filter((sample) => sample.metric === "step_count");
    expect(steps).toEqual([expect.objectContaining({ qty: 20, source: "Ryan's iPhone", date: "2026-11-10", units: "count" })]);
  });

  it("keeps a lower-priority range that does not overlap a higher-priority point", async () => {
    const parsed = await parseAppleExport(
      appleExport(`${stepRecord("Apple Watch", 100, "2026-11-09 08:00:00 -0500", "2026-11-09 08:00:00 -0500")}
  ${stepRecord("iPhone", 40, "2026-11-09 12:00:00 -0500", "2026-11-09 13:00:00 -0500")}`),
      { timeZone: "America/New_York", sourcePriority: "Apple Watch,iPhone" },
    );
    const steps = parsed.samples.filter((sample) => sample.metric === "step_count");
    expect(steps).toEqual([expect.objectContaining({ qty: 140, source: "Apple Watch", date: "2026-11-09", units: "count" })]);
  });
});

describe("rollupMetric", () => {
  it("averages one day's blood pressure into a single row", () => {
    const day = "2026-11-09";
    function pressure(systolic: number, diastolic: number, start: string): SampleRow {
      return {
        metric: "blood_pressure",
        date: day,
        start_ts: start,
        end_ts: null,
        source: "Health",
        qty: null,
        qty_min: diastolic,
        qty_avg: null,
        qty_max: systolic,
        units: "mmHg",
        label: null,
        extra: null,
        kind: "blood_pressure",
        series_key: null,
      };
    }
    expect(rollupMetric([pressure(120, 80, `${day} 08:00:00`), pressure(140, 90, `${day} 20:00:00`)])).toEqual({
      kind: "blood_pressure",
      truncated: false,
      rows: [{ date: day, systolic: 130, diastolic: 85, units: "mmHg" }],
    });
  });
});

function sample(id: string, date: string, seriesKey: string | null): Sample {
  return {
    id,
    metric: "step_count",
    date,
    start_ts: `${date} 00:00:00`,
    end_ts: null,
    source: "iPhone",
    qty: 1,
    qty_min: null,
    qty_avg: null,
    qty_max: null,
    units: "count",
    label: null,
    extra: null,
    kind: "sum",
    series_key: seriesKey,
  };
}

function workout(date: string): Workout {
  return {
    id: `workout-${date}`,
    name: "Running",
    start_ts: `${date} 07:00:00`,
    end_ts: `${date} 07:30:00`,
    date,
    duration_s: 1800,
    active_kcal: null,
    total_kcal: null,
    distance_qty: null,
    distance_units: null,
    hr_min: null,
    hr_avg: null,
    hr_max: null,
    location: null,
    source: "Apple Watch",
    summary: null,
    series_key: null,
  };
}

function event(date: string): HealthEvent {
  return {
    id: `event-${date}`,
    kind: "symptom",
    subtype: "Headache",
    start_ts: `${date} 09:00:00`,
    end_ts: null,
    date,
    source: "Health",
    payload: {},
    series_key: null,
  };
}

function datedFixture(): Normalized {
  return {
    samples: [
      sample("s1", "2026-11-01", "series/steps-a"),
      sample("s2", "2026-11-01", null),
      sample("s3", "2026-11-02", "series/steps-b"),
      sample("s4", "2026-11-03", null),
    ],
    workouts: [workout("2026-11-01")],
    events: [event("2026-11-01")],
    series: [
      { key: "series/steps-a", body: { part: "a" } },
      { key: "series/steps-b", body: { part: "b" } },
      { key: "series/unused", body: { part: "nope" } },
    ],
  };
}

function datesOf(chunk: Normalized): string[] {
  return [...new Set([...chunk.samples, ...chunk.workouts, ...chunk.events].map((row) => row.date))].sort();
}

describe("chunkNormalized", () => {
  it("sends a series only with the chunk that references it", () => {
    const chunks = chunkNormalized(datedFixture(), 1);
    expect(chunks.map((chunk) => chunk.series)).toEqual([
      [{ key: "series/steps-a", body: { part: "a" } }],
      [{ key: "series/steps-b", body: { part: "b" } }],
      [],
    ]);
  });

  it("keeps every record for a date in one chunk", () => {
    const chunks = chunkNormalized(datedFixture(), 2);
    expect(chunks).toHaveLength(2);
    expect(datesOf(chunks[0])).toEqual(["2026-11-01", "2026-11-02"]);
    expect(chunks[0].samples.map((row) => row.id)).toEqual(["s1", "s2", "s3"]);
    expect(chunks[0].workouts.map((row) => row.id)).toEqual(["workout-2026-11-01"]);
    expect(chunks[0].events.map((row) => row.id)).toEqual(["event-2026-11-01"]);
    expect(datesOf(chunks[1])).toEqual(["2026-11-03"]);
    expect(chunks[1].samples.map((row) => row.id)).toEqual(["s4"]);
    expect(chunks[1].workouts).toEqual([]);
    expect(chunks[1].events).toEqual([]);
  });

  it("groups dates when datesPerChunk is 0", () => {
    const chunks = chunkNormalized(datedFixture(), 0);
    expect(chunks).toHaveLength(3);
    expect(chunks.map(datesOf)).toEqual([["2026-11-01"], ["2026-11-02"], ["2026-11-03"]]);
    expect(chunks[0].samples.map((row) => row.id)).toEqual(["s1", "s2"]);
    expect(chunks[0].workouts.map((row) => row.id)).toEqual(["workout-2026-11-01"]);
    expect(chunks[0].events.map((row) => row.id)).toEqual(["event-2026-11-01"]);
  });
});
