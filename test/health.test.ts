/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AppleExportError, parseAppleExport } from "../src/parse/apple.js";
import { metricRollup } from "../src/storage.js";

const TOKEN = "Bearer test-token";
const DAY = "2024-02-06";

interface TestEnv {
  DB: D1Database;
  SERIES: R2Bucket;
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const testEnv = env as unknown as TestEnv;

const HAE = {
  data: {
    metrics: [
      { name: "step_count", units: "count", data: [{ qty: 8500, date: "2024-02-06 00:00:00 -0800", source: "iPhone" }] },
      { name: "heart_rate", units: "count/min", data: [{ date: "2024-02-06 14:30:00 -0800", Min: 65, Avg: 72, Max: 85, source: "Apple Watch" }] },
      {
        name: "sleep_analysis",
        units: "hr",
        data: [{
          date: "2024-02-06 00:00:00 -0800",
          totalSleep: 7.5,
          asleep: 0.5,
          core: 3.5,
          deep: 1.5,
          rem: 2,
          awake: 0,
          inBed: 8,
          sleepStart: "2024-02-05 23:00:00 -0800",
          sleepEnd: "2024-02-06 06:30:00 -0800",
          source: "Apple Watch",
        }],
      },
      { name: "blood_pressure", units: "mmHg", data: [{ date: "2024-02-06 14:30:00 -0800", systolic: 120, diastolic: 80, source: "Health" }] },
      { name: "sexual_activity", units: "count", data: [{ date: "2024-02-06 00:00:00 -0800", Unspecified: 0, "Protection Used": 1, "Protection Not Used": 0, source: "Health" }] },
      { name: "dietary_energy", units: "kJ", data: [{ qty: 418.4, date: "2024-02-06 08:00:00 -0800", foodType: "Chicken", source: "Lose It!" }] },
      { name: "blood_glucose", units: "mg/dL", data: [{ qty: 95, date: "2024-02-06 08:00:00 -0800", mealTime: "Before Meal", source: "Health" }] },
      { name: "handwashing", units: "s", data: [{ date: "2024-02-06 12:00:00 -0800", qty: 25, value: "Completed", source: "Apple Watch" }] },
      { name: "insulin_delivery", units: "IU", data: [{ qty: 5, date: "2024-02-06 08:00:00 -0800", reason: "Bolus", source: "Health" }] },
      { name: "physical_effort", units: "kcal/hr·kg", data: [{ qty: 4, date: "2024-02-06 10:00:00 -0800", source: "Apple Watch" }] },
    ],
    workouts: [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Running",
        start: "2024-02-06 07:00:00 -0800",
        end: "2024-02-06 07:30:00 -0800",
        duration: 1800,
        activeEnergyBurned: { qty: 350, units: "kcal" },
        heartRate: {
          min: { qty: 120, units: "count/min" },
          avg: { qty: 150, units: "count/min" },
          max: { qty: 175, units: "count/min" },
        },
        route: [{ latitude: 37.77, longitude: -122.42, altitude: 10, timestamp: "2024-02-06 07:00:00 -0800" }],
      },
      { name: "Cycling", start: "2024-02-06 16:00:00 -0800", end: "2024-02-06 16:20:00 -0800", duration: 1200 },
    ],
    symptoms: [{ name: "Headache", start: "2024-02-06 09:00:00 -0800", end: "2024-02-06 11:00:00 -0800", severity: "Moderate", source: "Health" }],
    cycleTracking: [{ name: "Menstrual Flow", start: "2024-02-06 00:00:00 -0800", value: "Medium", source: "Health" }],
    medications: [{ displayText: "Vitamin D", scheduledDate: "2024-02-06 08:00:00 -0800", status: "taken", dosage: 1, units: "capsule", source: "Health" }],
    stateOfMind: [{ id: "mood-1", start: "2024-02-06 18:00:00 -0800", end: "2024-02-06 18:00:00 -0800", kind: "Momentary Emotion", valence: 0.4, labels: ["Happy"], source: "Health" }],
    ecg: [{
      start: "2024-02-06 12:00:00 -0800",
      end: "2024-02-06 12:00:30 -0800",
      classification: "Sinus Rhythm",
      averageHeartRate: 72,
      samplingFrequency: 512,
      voltageMeasurements: [0.1, 0.2, 0.1],
      source: "Apple Watch",
    }],
    heartRateNotifications: [{ type: "High Heart Rate", start: "2024-02-06 15:00:00 -0800", end: "2024-02-06 15:05:00 -0800", threshold: 120, source: "Apple Watch" }],
    moods: [{ note: "steady", date: "2024-02-06 10:00:00 -0800", source: "Journal" }],
  },
};

const APPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2024-02-07 08:00:00 -0800"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="1000" startDate="2024-02-06 10:00:00 -0800" endDate="2024-02-06 10:00:00 -0800"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="8000" startDate="2024-02-06 10:00:00 -0800" endDate="2024-02-06 10:00:00 -0800"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" value="60" startDate="2024-02-06 08:00:00 -0800" endDate="2024-02-06 08:00:00 -0800"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" value="80" startDate="2024-02-06 08:01:00 -0800" endDate="2024-02-06 08:01:00 -0800"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2024-02-05 23:00:00 -0800" endDate="2024-02-06 01:00:00 -0800"/>
  <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Health" startDate="2024-02-06 09:00:00 -0800" endDate="2024-02-06 09:00:00 -0800">
    <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Health" unit="mmHg" value="120" startDate="2024-02-06 09:00:00 -0800" endDate="2024-02-06 09:00:00 -0800"/>
    <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic" sourceName="Health" unit="mmHg" value="80" startDate="2024-02-06 09:00:00 -0800" endDate="2024-02-06 09:00:00 -0800"/>
  </Correlation>
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" totalEnergyBurned="300" totalEnergyBurnedUnit="kcal" totalDistance="5" totalDistanceUnit="km" sourceName="Apple Watch" startDate="2024-02-06 07:00:00 -0800" endDate="2024-02-06 07:30:00 -0800">
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150" minimum="120" maximum="170" unit="count/min"/>
  </Workout>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="9" startDate="2024-02-07 01:00:00 -0800" endDate="2024-02-07 01:00:00 -0800"/>
</HealthData>`;

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", TOKEN);
  return SELF.fetch(`https://health-mcp.test${path}`, { ...init, headers });
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return authed(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function count(table: string): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM samples"),
    testEnv.DB.prepare("DELETE FROM workouts"),
    testEnv.DB.prepare("DELETE FROM events"),
    testEnv.DB.prepare("DELETE FROM ingest_window"),
    testEnv.DB.prepare("DELETE FROM ingest_receipt"),
    testEnv.DB.prepare("DELETE FROM export_hint"),
  ]);
  const listed = await testEnv.SERIES.list();
  await Promise.all(listed.objects.map((object) => testEnv.SERIES.delete(object.key)));
});

describe("Health Auto Export ingest", () => {
  it("stores every documented shape, rolls heart rate up, and replaces a re-post", async () => {
    const first = await postJson("/ingest", HAE);
    expect(first.status).toBe(200);
    const saved = await first.json<{ samples: number; workouts: number; events: number }>();
    expect(saved.workouts).toBe(2);
    expect(saved.events).toBe(7);
    expect(saved.samples).toBeGreaterThanOrEqual(10);

    const summaryResponse = await authed(`/summary?date=${DAY}`);
    expect(summaryResponse.status).toBe(200);
    const summary = await summaryResponse.json<{
      steps: number;
      dietary_kcal: number;
      sleep: { total_hr: number; core_hr: number };
      workouts: { name: string; duration_min: number; kcal: number }[];
    }>();
    expect(summary.steps).toBe(8500);
    expect(summary.dietary_kcal).toBe(100);
    expect(summary.sleep.total_hr).toBe(7.5);
    expect(summary.sleep.core_hr).toBe(3.5);
    expect(summary.workouts.map((workout) => workout.name).sort()).toEqual(["Cycling", "Running"]);
    expect(summary.workouts.find((workout) => workout.name === "Running")).toMatchObject({ duration_min: 30, kcal: 350 });

    const heart = await testEnv.DB.prepare("SELECT qty, qty_min, qty_avg, qty_max, kind FROM samples WHERE metric = 'heart_rate'").first<{
      qty: number;
      qty_min: number;
      qty_avg: number;
      qty_max: number;
      kind: string;
    }>();
    expect(heart).toMatchObject({ qty: 72, qty_min: 65, qty_avg: 72, qty_max: 85, kind: "min_avg_max" });

    const pressure = await testEnv.DB.prepare("SELECT qty_min, qty_max FROM samples WHERE metric = 'blood_pressure'").first<{ qty_min: number; qty_max: number }>();
    expect(pressure).toMatchObject({ qty_min: 80, qty_max: 120 });

    const glucose = await testEnv.DB.prepare("SELECT extra FROM samples WHERE metric = 'blood_glucose'").first<{ extra: string }>();
    expect(JSON.parse(glucose?.extra || "{}")).toMatchObject({ mealTime: "Before Meal" });

    const effort = await testEnv.DB.prepare("SELECT kind FROM samples WHERE metric = 'physical_effort'").first<{ kind: string }>();
    expect(effort?.kind).toBeTruthy();

    const series = await testEnv.SERIES.list();
    expect(series.objects.length).toBeGreaterThanOrEqual(2);

    const samples = await count("samples");
    const workouts = await count("workouts");
    const events = await count("events");
    const second = await postJson("/ingest", HAE);
    expect(second.status).toBe(200);
    expect(await count("samples")).toBe(samples);
    expect(await count("workouts")).toBe(workouts);
    expect(await count("events")).toBe(events);
  });

  it("rejects CSV and closes the import window", async () => {
    const csv = await authed("/ingest", { method: "POST", headers: { "content-type": "text/csv" }, body: "a,b" });
    expect(csv.status).toBe(415);

    const opened = await postJson("/ingest", HAE);
    expect(opened.status).toBe(200);
    const closed = await postJson("/ingest", { backfill: "done" });
    expect(closed.status).toBe(200);
    const stale = await postJson("/ingest", {
      data: { metrics: [{ name: "step_count", units: "count", data: [{ qty: 10, date: "2020-01-01 00:00:00 +0000" }] }] },
    });
    expect(stale.status).toBe(422);
    const body = await stale.json<{ error: string }>();
    expect(body.error).toBe("outside_window");

    const today = new Date().toISOString().slice(0, 10);
    const recent = await postJson("/ingest", {
      data: { metrics: [{ name: "step_count", units: "count", data: [{ qty: 12, date: `${today} 12:00:00 +0000`, source: "iPhone" }] }] },
    });
    expect(recent.status).toBe(200);
  });

  it("requires the bearer token", async () => {
    const response = await SELF.fetch("https://health-mcp.test/summary?date=2024-02-06");
    expect(response.status).toBe(401);
  });
});

describe("Apple Health import", () => {
  it("keeps one source per day, dates sleep by wake day, and drops the export day", async () => {
    const parsed = await parseAppleExport(APPLE_XML, { timeZone: "America/Los_Angeles" });
    const steps = parsed.samples.find((sample) => sample.metric === "step_count");
    expect(steps).toMatchObject({ qty: 8000, source: "Apple Watch", date: DAY });
    expect(parsed.samples.some((sample) => sample.date === "2024-02-07")).toBe(false);
    expect(parsed.samples.find((sample) => sample.metric === "heart_rate")).toMatchObject({
      kind: "min_avg_max",
      qty_min: 60,
      qty_avg: 70,
      qty_max: 80,
    });
    expect(parsed.samples.find((sample) => sample.metric === "sleep_analysis")).toMatchObject({ date: DAY, label: "Core", qty: 2 });
    expect(parsed.samples.find((sample) => sample.metric === "blood_pressure")).toMatchObject({ qty_min: 80, qty_max: 120 });
    expect(parsed.workouts[0]).toMatchObject({ name: "Running", duration_s: 1800, active_kcal: 300, hr_min: 120, hr_avg: 150, hr_max: 170 });

    const preferred = await parseAppleExport(APPLE_XML, { timeZone: "America/Los_Angeles", sourcePriority: "iPhone" });
    expect(preferred.samples.find((sample) => sample.metric === "step_count")).toMatchObject({ qty: 1000, source: "iPhone" });

    const imported = await postJson("/import/apple-health/chunk", parsed);
    expect(imported.status).toBe(200);
    const summary = await (await authed(`/summary?date=${DAY}`)).json<{ steps: number }>();
    expect(summary.steps).toBe(8000);

    const live = await postJson("/ingest", {
      data: { metrics: [{ name: "step_count", units: "count", data: [{ qty: 100, date: "2024-02-06 00:00:00 -0800", source: "iPhone" }] }] },
    });
    expect(live.status).toBe(200);
    const replaced = await (await authed(`/summary?date=${DAY}`)).json<{ steps: number }>();
    expect(replaced.steps).toBe(100);
    const rolled = await metricRollup(testEnv.DB, "step_count", DAY, DAY, 500);
    expect(rolled.rows).toEqual([{ date: DAY, qty: 100, units: "count" }]);
  });
});

describe("import window", () => {
  it("does not open the window for an empty post, and a retry does not add bytes twice", async () => {
    const empty = await postJson("/ingest", { data: { metrics: [] } });
    expect(empty.status).toBe(200);
    const windows = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ingest_window").first<{ n: number }>();
    expect(windows?.n).toBe(0);

    const body = {
      data: { metrics: [{ name: "step_count", units: "count", data: [{ qty: 10, date: "2024-02-06 08:00:00 -0800", source: "iPhone" }] }] },
    };
    const size = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect((await postJson("/ingest", body)).status).toBe(200);
    expect((await postJson("/ingest", body)).status).toBe(200);
    const row = await testEnv.DB.prepare("SELECT bytes FROM ingest_window WHERE id = 1").first<{ bytes: number }>();
    const posts = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ingest_receipt").first<{ n: number }>();
    expect(row?.bytes).toBe(size);
    expect(posts?.n).toBe(1);

    await testEnv.DB.prepare("DELETE FROM ingest_window").run();
    expect((await postJson("/ingest", body)).status).toBe(200);
    const repaired = await testEnv.DB.prepare("SELECT bytes FROM ingest_window WHERE id = 1").first<{ bytes: number }>();
    const postsAfter = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ingest_receipt").first<{ n: number }>();
    expect(repaired?.bytes).toBe(size);
    expect(postsAfter?.n).toBe(1);
  });
});

describe("metric rollup", () => {
  it("keeps every day of a min, average, and max metric", async () => {
    const statements = [];
    for (let day = 1; day <= 3; day += 1) {
      const date = `2024-03-0${day}`;
      for (const [hour, qty] of [
        [0, 60],
        [1, 80],
        [2, 70],
      ] as const) {
        statements.push(
          testEnv.DB
            .prepare(
              "INSERT INTO samples (id, metric, date, start_ts, source, qty, qty_min, qty_avg, qty_max, units, kind) VALUES (?, 'heart_rate', ?, ?, '', ?, ?, ?, ?, 'count/min', 'min_avg_max')",
            )
            .bind(`hr-${date}-${hour}`, date, `${date} 0${hour}:00:00`, qty, qty - 5, qty, qty + 5),
        );
      }
    }
    await testEnv.DB.batch(statements);
    const rolled = await metricRollup(testEnv.DB, "heart_rate", "2024-03-01", "2024-03-03", 500);
    expect(rolled.truncated).toBe(false);
    expect(rolled.kind).toBe("min_avg_max");
    expect(rolled.rows).toHaveLength(3);
    expect(rolled.rows[0]).toMatchObject({ date: "2024-03-01", min: 55, avg: 70, max: 85 });
  });
});

describe("MCP", () => {
  it("answers read-only tool calls", async () => {
    expect((await postJson("/ingest", HAE)).status).toBe(200);
    const headers = { authorization: TOKEN, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const initialize = await SELF.fetch("https://health-mcp.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1.0.0" } },
      }),
    });
    expect(initialize.status).toBe(200);
    const session = initialize.headers.get("mcp-session-id");
    const callHeaders = new Headers(headers);
    if (session) callHeaders.set("mcp-session-id", session);
    await SELF.fetch("https://health-mcp.test/mcp", {
      method: "POST",
      headers: callHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    async function callTool(name: string, args: Record<string, unknown>) {
      const response = await SELF.fetch("https://health-mcp.test/mcp", {
        method: "POST",
        headers: callHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const payload = text.includes("data:")
        ? JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5))
        : JSON.parse(text);
      const result = payload.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
      expect(result.isError, text).toBeFalsy();
      return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || "{}");
    }

    const metrics = await callTool("query_metrics", { metric: "heart_rate", start_date: DAY, end_date: DAY });
    expect(metrics).toMatchObject({ kind: "min_avg_max", rows: [{ date: DAY, min: 65, avg: 72, max: 85 }] });

    const listed = await callTool("list_metrics", {});
    expect(JSON.stringify(listed)).toContain("heart_rate");

    const day = await callTool("get_daily_summary", { date: DAY });
    expect(day).toMatchObject({ steps: 8500, dietary_kcal: 100 });

    const workouts = await callTool("query_workouts", { start_date: DAY, end_date: DAY });
    expect(JSON.stringify(workouts)).toContain("Running");
    expect(JSON.stringify(workouts)).not.toContain("latitude");

    const symptoms = await callTool("query_events", { kind: "symptom", start_date: DAY, end_date: DAY });
    expect(JSON.stringify(symptoms)).toContain("Headache");

    const ecg = await callTool("query_events", { kind: "ecg", start_date: DAY, end_date: DAY });
    const ecgText = JSON.stringify(ecg);
    expect(ecgText).toContain("Sinus Rhythm");
    expect(ecgText).not.toContain("voltageMeasurements");

    const keyRow = await testEnv.DB.prepare("SELECT series_key FROM workouts WHERE series_key IS NOT NULL LIMIT 1").first<{ series_key: string }>();
    const series = await callTool("get_series", { key: keyRow?.series_key, part: "route" });
    expect(JSON.stringify(series)).toContain("37.77");
  });
});

const WATCH = "Ryan\u2019s Apple Watch";
const PHONE = "Ryan\u2019s iPhone";

function step(source: string, value: number, day: string, start: string, end: string): string {
  return `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${source}" unit="count" value="${value}" startDate="${day} ${start} -0500" endDate="${day} ${end} -0500"/>`;
}

function zipLocal(name: string, method: number, flags: number, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const bytes = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, flags, true);
  view.setUint16(8, method, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  bytes.set(nameBytes, 30);
  bytes.set(data, 30 + nameBytes.length);
  return bytes;
}

function dataDescriptor(size: number, signed: boolean): Uint8Array {
  const bytes = new Uint8Array(signed ? 16 : 12);
  const view = new DataView(bytes.buffer);
  const offset = signed ? 4 : 0;
  if (signed) view.setUint32(0, 0x08074b50, true);
  view.setUint32(offset + 4, size, true);
  view.setUint32(offset + 8, size, true);
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("Apple source dedupe", () => {
  it("merges overlapping Watch and iPhone samples instead of summing the day", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2026-11-12 08:00:00 -0500"/>
  ${step(WATCH, 2248, "2026-11-09", "10:00:00", "11:00:00")}
  ${step(PHONE, 1217, "2026-11-09", "10:00:00", "11:00:00")}
  ${step(WATCH, 8748, "2026-11-05", "10:00:00", "11:00:00")}
  ${step(PHONE, 7492, "2026-11-05", "10:00:00", "11:00:00")}
  ${step(WATCH, 32, "2026-11-10", "10:00:00", "11:00:00")}
  ${step(PHONE, 73, "2026-11-10", "10:00:00", "11:00:00")}
  ${step(WATCH, 939, "2026-11-06", "08:00:00", "12:00:00")}
  ${step(PHONE, 2297, "2026-11-06", "08:00:00", "20:00:00")}
  ${step(WATCH, 100, "2026-11-02", "08:00:00", "09:00:00")}
  ${step(PHONE, 40, "2026-11-02", "12:00:00", "13:00:00")}
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="${WATCH}" unit="count" value="100" startDate="2026-11-03 23:00:00 -0500" endDate="2026-11-04 01:00:00 -0500"/>
  ${step(WATCH, 50, "2026-11-08", "10:00:00", "11:00:00")}
  ${step("Ryan's iPhone", 20, "2026-11-08", "10:00:00", "11:00:00")}
  ${step("Ryan\u2019s iPhone 13 Pro", 15, "2026-11-08", "11:00:00", "12:00:00")}
  ${step("Ryan\u2019s iPhone XS", 15, "2026-11-08", "11:00:00", "12:00:00")}
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="${WATCH}" unit="count/min" value="60" startDate="2026-11-07 08:00:00 -0500" endDate="2026-11-07 08:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="${WATCH}" unit="count/min" value="80" startDate="2026-11-07 09:00:00 -0500" endDate="2026-11-07 09:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="${PHONE}" unit="count/min" value="40" startDate="2026-11-07 08:00:00 -0500" endDate="2026-11-07 08:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="${PHONE}" unit="count/min" value="120" startDate="2026-11-07 09:00:00 -0500" endDate="2026-11-07 09:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="${WATCH}" unit="kg" value="80" startDate="2026-11-07 08:00:00 -0500" endDate="2026-11-07 08:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Withings" unit="kg" value="72" startDate="2026-11-07 21:00:00 -0500" endDate="2026-11-07 21:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${WATCH}" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-11-09 23:00:00 -0500" endDate="2026-11-10 06:10:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${PHONE}" value="HKCategoryValueSleepAnalysisInBed" startDate="2026-11-10 06:10:00 -0500" endDate="2026-11-10 23:56:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${PHONE}" value="HKCategoryValueSleepAnalysisAwake" startDate="2026-11-10 06:10:00 -0500" endDate="2026-11-10 07:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${PHONE}" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-11-10 07:00:00 -0500" endDate="2026-11-10 08:00:00 -0500"/>
  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Clock" value="HKCategoryValueSleepAnalysisInBed" startDate="2026-11-10 06:10:00 -0500" endDate="2026-11-10 23:56:00 -0500"/>
</HealthData>`;
    const parsed = await parseAppleExport(xml, { timeZone: "America/New_York", sourcePriority: "Apple Watch,iPhone" });
    const steps = (date: string) => parsed.samples.find((sample) => sample.metric === "step_count" && sample.date === date);

    expect(steps("2026-11-09")?.qty).toBe(2248);
    expect(steps("2026-11-05")?.qty).toBe(8748);
    expect(steps("2026-11-10")?.qty).toBe(32);
    expect(steps("2026-11-06")?.qty).toBeCloseTo(939 + (2297 * 8) / 12, 5);
    expect(steps("2026-11-02")?.qty).toBe(140);
    expect(steps("2026-11-03")?.qty).toBe(50);
    expect(steps("2026-11-04")?.qty).toBe(50);

    const late = await parseAppleExport(
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2026-11-12 08:00:00 -0500"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="100" startDate="2026-11-04 04:00:00" endDate="2026-11-04 06:00:00"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="100" startDate="2026-03-07 23:00:00 -0500" endDate="2026-03-08 04:00:00 -0400"/>
</HealthData>`,
      { timeZone: "America/New_York" },
    );
    const lateSteps = (date: string) => late.samples.find((sample) => sample.metric === "step_count" && sample.date === date);
    expect(lateSteps("2026-11-03")?.qty).toBeCloseTo(50, 5);
    expect(lateSteps("2026-11-04")?.qty).toBeCloseTo(50, 5);
    expect(lateSteps("2026-03-07")?.qty).toBeCloseTo(25, 5);
    expect(lateSteps("2026-03-08")?.qty).toBeCloseTo(75, 5);
    expect(steps("2026-11-08")).toMatchObject({ qty: 65, source: WATCH });

    expect(parsed.samples.find((sample) => sample.metric === "heart_rate")).toMatchObject({
      qty_min: 60,
      qty_avg: 70,
      qty_max: 80,
      source: WATCH,
    });
    expect(parsed.samples.find((sample) => sample.metric === "weight_body_mass")).toMatchObject({ qty: 72, source: "Withings" });

    const sleep = parsed.samples.filter((sample) => sample.metric === "sleep_analysis");
    expect(sleep.length).toBeGreaterThan(0);
    expect(sleep.every((sample) => sample.source === WATCH)).toBe(true);
    expect(sleep.some((sample) => sample.end_ts?.includes("23:56"))).toBe(false);
    expect(sleep[0]).toMatchObject({ date: "2026-11-10", label: "Core" });
  });

  it("replaces source-keyed Apple rows so a rerun is not added to the old total", async () => {
    const day = "2026-11-06";
    await testEnv.DB.batch([
      testEnv.DB
        .prepare(
          "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind, extra) VALUES ('legacy-watch', 'step_count', ?, ?, ?, 939, 'count', 'sum', '{\"apple\":true}')",
        )
        .bind(day, `${day} 00:00:00`, WATCH),
      testEnv.DB
        .prepare(
          "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind, extra) VALUES ('legacy-phone', 'step_count', ?, ?, ?, 2297, 'count', 'sum', '{\"apple\":true}')",
        )
        .bind(day, `${day} 00:00:00`, PHONE),
      testEnv.DB
        .prepare(
          "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind, extra) VALUES ('legacy-other-day', 'step_count', '2026-11-01', '2026-11-01 00:00:00', ?, 10, 'count', 'sum', '{\"apple\":true}')",
        )
        .bind(WATCH),
    ]);
    const doubled = await metricRollup(testEnv.DB, "step_count", day, day, 500);
    expect(doubled.rows).toEqual([{ date: day, qty: 3236, units: "count" }]);

    const parsed = await parseAppleExport(
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2026-11-12 08:00:00 -0500"/>
  ${step(WATCH, 939, day, "08:00:00", "12:00:00")}
  ${step(PHONE, 2297, day, "08:00:00", "20:00:00")}
</HealthData>`,
      { timeZone: "America/New_York", sourcePriority: "Apple Watch,iPhone" },
    );
    const imported = await postJson("/import/apple-health/chunk", parsed);
    expect(imported.status).toBe(200);
    const rolled = await metricRollup(testEnv.DB, "step_count", day, day, 500);
    const rolledRow = rolled.rows[0] as { date: string; qty: number };
    expect(rolledRow.date).toBe(day);
    expect(rolledRow.qty).toBeCloseTo(939 + (2297 * 8) / 12, 5);
    const rows = await testEnv.DB.prepare("SELECT id, qty FROM samples WHERE metric = 'step_count' AND date = ?").bind(day).all<{ id: string; qty: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.id).not.toBe("legacy-watch");
    const kept = await testEnv.DB.prepare("SELECT qty FROM samples WHERE id = 'legacy-other-day'").first<{ qty: number }>();
    expect(kept?.qty).toBe(10);

    expect((await postJson("/ingest", {
      data: { metrics: [{ name: "step_count", units: "count", data: [{ qty: 50, date: `${day} 12:00:00 -0500`, source: "iPhone" }] }] },
    })).status).toBe(200);
    const preferred = await metricRollup(testEnv.DB, "step_count", day, day, 500);
    expect(preferred.rows).toEqual([{ date: day, qty: 50, units: "count" }]);
    const appleLeft = await testEnv.DB
      .prepare("SELECT qty FROM samples WHERE metric = 'step_count' AND date = ? AND json_extract(COALESCE(extra, '{}'), '$.apple') = 1")
      .bind(day)
      .all<{ qty: number }>();
    expect(appleLeft.results).toHaveLength(1);
  });

  it("reads a stored zip and rejects compression it cannot inflate", async () => {
    const xml = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <ExportDate value="2024-02-07 08:00:00 -0800"/>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" value="10" startDate="2024-02-06 10:00:00 -0800" endDate="2024-02-06 10:00:00 -0800"/>
</HealthData>`);
    const stored = await parseAppleExport(zipLocal("export.xml", 0, 0, xml), { timeZone: "America/Los_Angeles" });
    expect(stored.samples.find((sample) => sample.metric === "step_count")?.qty).toBe(10);
    const described = await parseAppleExport(concatBytes([zipLocal("export.xml", 0, 0x8, xml), dataDescriptor(xml.length, true)]), {
      timeZone: "America/Los_Angeles",
    });
    expect(described.samples.find((sample) => sample.metric === "step_count")?.qty).toBe(10);
    const notes = new TextEncoder().encode("notes");
    const ahead = concatBytes([
      zipLocal("workout-routes/note.txt", 0, 0x8, notes),
      dataDescriptor(notes.length, false),
      zipLocal("export.xml", 0, 0, xml),
    ]);
    const afterSkipped = await parseAppleExport(ahead, { timeZone: "America/Los_Angeles" });
    expect(afterSkipped.samples.find((sample) => sample.metric === "step_count")?.qty).toBe(10);

    await expect(parseAppleExport(zipLocal("export.xml", 9, 0, xml))).rejects.toMatchObject({ code: "UNSUPPORTED_ZIP" });
    await expect(parseAppleExport(zipLocal("export.xml", 9, 0, xml))).rejects.toThrow(/ditto -x -k/);
    const zeroSized = zipLocal("export.xml", 0, 0x8, xml);
    new DataView(zeroSized.buffer).setUint32(18, 0, true);
    new DataView(zeroSized.buffer).setUint32(22, 0, true);
    await expect(parseAppleExport(zeroSized)).rejects.toBeInstanceOf(AppleExportError);
  });
});
