import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { payloadError, parse } from "../src/core/parse.js";

const NOW = new Date("2026-10-16T15:00:00Z");

function request(pathname, { method = "POST", body, headers = {} } = {}) {
  const init = new Headers(headers);
  init.set("authorization", "Bearer tok");
  if (body != null && !init.has("content-type")) init.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, { method, headers: init, body });
}

function ctx(storage, extra = {}) {
  return { token: "tok", storage, timeZone: "America/New_York", now: NOW, ingestRatePerHour: 0, ...extra };
}

const payload = {
  data: {
    metrics: [
      {
        name: "step_count",
        units: "count",
        data: [
          { qty: 120, date: "2020-03-01 09:15:00 -0500", source: "iPhone" },
          { qty: 80, date: "2020-03-01 18:00:00 -0500", source: "iPhone" },
        ],
      },
      {
        name: "heart_rate",
        units: "count/min",
        data: [{ date: "2020-03-01 09:00:00 -0500", Min: 61, Avg: 74, Max: 110, source: "Apple Watch" }],
      },
      {
        name: "blood_pressure",
        units: "mmHg",
        data: [{
          date: "2020-03-01 08:00:00 -0500",
          start: "2020-03-01 08:00:00 -0500",
          end: "2020-03-01 08:00:00 -0500",
          systolic: 118,
          diastolic: 76,
          source: "Health",
        }],
      },
      {
        name: "sleep_analysis",
        units: "hr",
        data: [{
          date: "2020-03-01 00:00:00 -0500",
          totalSleep: 7.5,
          asleep: 0.5,
          core: 3.5,
          deep: 1.5,
          rem: 2.0,
          awake: 0.4,
          sleepStart: "2020-02-29 23:10:00 -0500",
          sleepEnd: "2020-03-01 06:40:00 -0500",
          inBed: 8.0,
          inBedStart: "2020-02-29 22:50:00 -0500",
          inBedEnd: "2020-03-01 06:50:00 -0500",
          source: "Apple Watch",
        }, {
          date: "2020-02-29 23:10:00 -0500",
          start: "2020-02-29 23:10:00 -0500",
          end: "2020-03-01 02:40:00 -0500",
          qty: 3.5,
          value: "Core",
          source: "Apple Watch",
        }],
      },
      {
        name: "oxygen_saturation",
        units: "%",
        data: [{ qty: 97, date: "2020-03-01 07:00:00 -0500", source: "Apple Watch" }],
      },
    ],
    workouts: [{
      id: "workout-1",
      name: "Running",
      start: "2020-03-01 07:00:00 -0500",
      end: "2020-03-01 07:30:00 -0500",
      duration: 1800,
      source: { name: "Workout", identifier: "com.apple.workout" },
      activeEnergyBurned: { qty: 280, units: "kcal" },
      distance: { qty: 3.1, units: "mi" },
      heartRate: { avg: { qty: 152, units: "count/min" }, max: { qty: 171, units: "count/min" } },
      heartRateData: [{ date: "2020-03-01 07:00:00 -0500", Min: 140, Avg: 150, Max: 160, units: "count/min", source: "Apple Watch" }],
      route: [{ latitude: 40.7, longitude: -74.0, altitude: 12, timestamp: "2020-03-01 07:00:00 -0500", speed: 3.1 }],
    }],
    symptoms: [{
      start: "2020-03-01 10:00:00 -0500",
      end: "2020-03-01 12:00:00 -0500",
      name: "Headache",
      severity: "Moderate",
      cycleStart: false,
      userEntered: true,
      source: "Health",
    }],
    ecg: [{
      start: "2020-03-01 14:30:00 -0500",
      end: "2020-03-01 14:30:30 -0500",
      classification: "Sinus Rhythm",
      averageHeartRate: 72,
      numberOfVoltageMeasurements: 4,
      voltageMeasurements: [
        { date: 1583083800, voltage: 120, units: "mcV" },
        { date: 1583083800.002, voltage: 128, units: "mcV" },
      ],
      samplingFrequency: 512,
      source: "Apple Watch",
    }],
    heartRateNotifications: [{
      heartNotification: "high_heart_rate_notification",
      start: "2020-03-01 14:30:00 -0500",
      end: "2020-03-01 14:35:00 -0500",
      threshold: 120,
      source: { name: "Apple Watch", identifier: "com.apple.health" },
      heartRateData: [{ qty: 128, units: "count/min", start: 1583083800, end: 1583083805 }],
    }],
    stateOfMind: [{
      id: "mind-1",
      start: "2020-03-01T22:00:00Z",
      end: "2020-03-01T22:05:00Z",
      kind: "daily_mood",
      labels: ["calm"],
      associations: ["work"],
      valence: 0.4,
      valenceClassification: "pleasant",
    }],
    cycleTracking: [{
      start: "2020-03-01 00:00:00 -0500",
      end: "2020-03-01 23:59:59 -0500",
      name: "Menstrual Flow",
      value: "Medium",
      isCycleStart: true,
    }],
    medications: [{
      displayText: "Example medication",
      nickname: "Morning",
      start: "2020-03-01 08:05:00 -0500",
      end: "2020-03-01 08:05:00 -0500",
      scheduledDate: "2020-03-01 08:00:00 -0500",
      status: "Taken",
      dosage: 1,
      units: "count",
      codings: [],
    }],
  },
};

test("HAE v2 payloads for every data type are accepted without an allowlist", () => {
  assert.equal(payloadError(payload), null);
  assert.equal(payloadError({ data: { symptoms: payload.data.symptoms } }), null);
  const parsed = parse(payload, { timeZone: "America/New_York" });
  assert.equal(parsed.points.some((point) => point.metric === "oxygen_saturation"), true);
  assert.equal(parsed.points.some((point) => point.metric === "heart_rate"), true);
  assert.equal(parsed.points.find((point) => point.metric === "blood_pressure").qty, 118);
  assert.equal(parsed.samples.find((row) => row.metric === "heart_rate").max_qty, 110);
  assert.equal(parsed.sleep.filter((row) => row.kind === "summary").length, 1);
  assert.equal(parsed.sleep.filter((row) => row.kind === "segment")[0].stage, "Core");
  assert.equal(parsed.workouts[0].kcal, 280);
  assert.deepEqual(parsed.records.map((row) => row.kind).sort(), [
    "cycle_tracking",
    "ecg",
    "heart_rate_notifications",
    "medications",
    "state_of_mind",
    "symptoms",
  ]);
});

test("authenticated ingest stores years of data and dedupes a repeat post", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const first = await handleRequest(request("/ingest", { body: JSON.stringify(payload) }), environment);
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  const body = await first.json();
  assert.equal(body.dropped_stale, 0);
  assert.ok(body.records >= 6);
  assert.equal((await storage.queryDaySummary("2020-03-01")).steps, 200);
  assert.equal((await storage.queryMetricRange("oxygen_saturation", "2020-03-01", "2020-03-01"))[0].last_qty, 97);
  const sleep = await storage.querySleep("2020-02-01", "2020-03-02", 20, 0);
  assert.equal(sleep.find((row) => row.kind === "summary").core_hr, 3.5);
  const workouts = await storage.queryWorkoutDetails("2020-03-01", "2020-03-01", 5, 0);
  assert.match(workouts[0].detail, /latitude/);
  const symptoms = await storage.queryRecords("symptoms", "2020-03-01", "2020-03-01", 5, 0);
  assert.equal(symptoms[0].name, "Headache");
  const before = storage.samples.size;
  const again = await handleRequest(request("/ingest", { body: JSON.stringify(payload) }), environment);
  assert.equal(again.status, 200);
  assert.equal(storage.samples.size, before);
  assert.equal((await storage.queryDaySummary("2020-03-01")).steps, 200);

  const limited = new MemoryStorage();
  limited.backfill = {
    opened_at: "2026-10-01T00:00:00.000Z",
    closed_at: "2026-10-01T00:00:00.000Z",
    bytes: 0,
    days: 0,
    deadline: "2026-10-01T00:00:00.000Z",
    total_bytes: 0,
  };
  const dropped = await handleRequest(request("/ingest", { body: JSON.stringify(payload) }), ctx(limited, { ingestMaxAgeDays: 1 }));
  assert.equal(dropped.status, 422);
});

test("MCP tools page raw metrics, sleep, workouts, records, and export", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  await handleRequest(request("/ingest", { body: JSON.stringify(payload) }), environment);
  async function tool(name, args) {
    const response = await handleRequest(request("/mcp", {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }), environment);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.result.isError, false, body.result.content?.[0]?.text);
    return body.result.structuredContent;
  }
  const coverage = await tool("list_coverage", {});
  assert.ok(coverage.coverage.some((row) => row.kind === "metric" && row.name === "oxygen_saturation"));
  assert.ok(coverage.coverage.some((row) => row.kind === "symptoms"));
  const raw = await tool("get_metric", {
    metric: "step_count",
    start_date: "2020-03-01",
    end_date: "2020-03-01",
    granularity: "raw",
  });
  assert.equal(raw.rows.length, 2);
  assert.equal(raw.rows[0].source, "iPhone");
  const month = await tool("get_metric", {
    metric: "step_count",
    start_date: "2020-03-01",
    end_date: "2020-03-31",
    granularity: "month",
  });
  assert.equal(month.rows[0].date, "2020-03");
  assert.equal(month.rows[0].sum_qty, 200);
  const nights = await tool("get_sleep", { start_date: "2020-02-01", end_date: "2020-03-02" });
  assert.equal(nights.sessions.find((row) => row.kind === "summary").rem_hr, 2);
  const detail = await tool("get_workout", { start_date: "2020-03-01", end_date: "2020-03-01" });
  assert.equal(detail.workouts[0].detail.distance.qty, 3.1);
  const meds = await tool("get_records", { kind: "medications", start_date: "2020-03-01", end_date: "2020-03-01" });
  assert.equal(meds.records[0].payload.status, "Taken");
  const summary = await tool("summarize_dates", { start_date: "2020-03-01", end_date: "2020-03-01" });
  assert.equal(summary.totals.steps, 200);
  const exported = await tool("export_health", { dataset: "records", kind: "ecg", format: "json" });
  assert.equal(exported.rows[0].payload.classification, "Sinus Rhythm");

  const csv = await handleRequest(request("/export?dataset=daily&format=csv&start=2020-03-01&end=2020-03-01", { method: "GET" }), environment);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(await csv.text(), /step_count/);
  const denied = await handleRequest(new Request("http://localhost/export?dataset=daily", { method: "GET" }), environment);
  assert.equal(denied.status, 401);
});

test("a later raw export replaces an all-day total instead of adding to it", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const summary = {
    data: {
      metrics: [{ name: "step_count", units: "count", data: [{ qty: 9000, date: "2020-03-01 00:00:00 -0500" }] }],
    },
  };
  const raw = {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { qty: 100, date: "2020-03-01 09:00:00 -0500" },
          { qty: 50, date: "2020-03-01 18:00:00 -0500" },
        ],
      }],
    },
  };
  assert.equal((await handleRequest(request("/ingest", { body: JSON.stringify(summary) }), environment)).status, 200);
  assert.equal((await storage.queryDaySummary("2020-03-01")).steps, 9000);
  assert.equal((await handleRequest(request("/ingest", { body: JSON.stringify(raw) }), environment)).status, 200);
  assert.equal((await storage.queryDaySummary("2020-03-01")).steps, 150);
});

test("a smaller raw set replaces a larger bucket total", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const buckets = {
    data: {
      metrics: [{
        name: "heart_rate",
        units: "count/min",
        data: [8, 9, 10, 11].map((hour) => ({
          date: `2020-03-01 ${String(hour).padStart(2, "0")}:00:00 -0500`,
          Min: 60,
          Avg: 70,
          Max: 80,
        })),
      }],
    },
  };
  const raw = {
    data: {
      metrics: [{
        name: "heart_rate",
        units: "count/min",
        data: [
          { qty: 72, date: "2020-03-01 09:15:00 -0500" },
          { qty: 80, date: "2020-03-01 10:15:00 -0500" },
        ],
      }],
    },
  };
  await handleRequest(request("/ingest", { body: JSON.stringify(buckets) }), environment);
  await handleRequest(request("/ingest", { body: JSON.stringify(raw) }), environment);
  const row = (await storage.queryMetricRange("heart_rate", "2020-03-01", "2020-03-01"))[0];
  assert.equal(row.n, 2);
  assert.equal(row.sum_qty, 152);
});

test("two foods logged at the same time are both stored", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const body = {
    data: {
      metrics: [{
        name: "dietary_energy",
        units: "kcal",
        data: [
          { qty: 100, date: "2020-03-01 08:00:00 -0500", foodType: "Apple", source: "Lose It!" },
          { qty: 240, date: "2020-03-01 08:00:00 -0500", foodType: "Oats", source: "Lose It!" },
        ],
      }],
    },
  };
  await handleRequest(request("/ingest", { body: JSON.stringify(body) }), environment);
  const samples = await storage.querySamples("dietary_energy", "2020-03-01", "2020-03-01", 10, 0);
  assert.equal(samples.length, 2);
  assert.equal((await storage.queryDaySummary("2020-03-01")).dietary_kcal, 340);
});

test("a later workout without a route keeps the stored route", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const rich = {
    data: {
      workouts: [{
        name: "Running",
        start: "2020-03-01 07:00:00 -0500",
        end: "2020-03-01 07:30:00 -0500",
        duration: 1800,
        activeEnergyBurned: { qty: 280, units: "kcal" },
        route: [{ latitude: 40.7, longitude: -74.0, timestamp: "2020-03-01 07:00:00 -0500" }],
      }],
    },
  };
  const slim = {
    data: {
      workouts: [{
        name: "Running",
        start: "2020-03-01 07:00:00 -0500",
        end: "2020-03-01 07:30:00 -0500",
        duration: 1800,
        activeEnergyBurned: { qty: 280, units: "kcal" },
      }],
    },
  };
  await handleRequest(request("/ingest", { body: JSON.stringify(rich) }), environment);
  await handleRequest(request("/ingest", { body: JSON.stringify(slim) }), environment);
  const [workout] = await storage.queryWorkoutDetails("2020-03-01", "2020-03-01", 5, 0);
  assert.match(workout.detail, /latitude/);
});

test("daily export returns one page from the database", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  await handleRequest(request("/ingest", { body: JSON.stringify(payload) }), environment);
  const response = await handleRequest(request("/export?dataset=daily&limit=1&start=2020-01-01&end=2020-12-31", { method: "GET" }), environment);
  const body = await response.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.next_cursor, "1");
});

test("the worker entry does not evaluate import.meta.url while loading", () => {
  const source = fs.readFileSync(new URL("../src/adapters/migrate.js", import.meta.url), "utf8");
  const prelude = source.split("function migrationsDirectory")[0];
  assert.doesNotMatch(prelude, /new URL\(/);
  assert.match(source, /function migrationsDirectory/);
});
