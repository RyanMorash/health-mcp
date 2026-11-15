/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authed } from "../src/auth.js";
import { dailyLimitResponse, d1DailyLimitKind, secondsUntilNextUtcMidnight } from "../src/free-tier.js";
import { metricRollup } from "../src/storage.js";

const TOKEN = "Bearer test-token";

interface TestEnv {
  DB: D1Database;
  SERIES: R2Bucket;
}

const testEnv = env as unknown as TestEnv;

const WRITE_LIMIT = "exceeded D1's free tier daily row write limit";
const READ_LIMIT = "exceeded D1's free tier daily row read limit";

function utcDay(offset: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function stepPost(date: string, qty: number, hour = "12") {
  return {
    data: {
      metrics: [{ name: "step_count", units: "count", data: [{ qty, date: `${date} ${hour}:00:00 +0000`, source: "iPhone" }] }],
    },
  };
}

function stepsOn(dates: string[], qty = 1) {
  return {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: dates.map((date) => ({ qty, date: `${date} 12:00:00 +0000`, source: "iPhone" })),
      }],
    },
  };
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", TOKEN);
  return SELF.fetch(`https://health-mcp.test${path}`, { ...init, headers });
}

async function postJson(path: string, body: unknown, extra?: HeadersInit): Promise<Response> {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  return authedFetch(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function count(table: "samples" | "ingest_window" | "ingest_receipt"): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function windowRow() {
  return testEnv.DB.prepare("SELECT closed_at, bytes, total_bytes FROM ingest_window WHERE id = 1").first<{
    closed_at: string | null;
    bytes: number;
    total_bytes: number | null;
  }>();
}

async function seedWindow(bytes: number, total: number, deadline: string): Promise<void> {
  const opened = "2026-01-01T00:00:00.000Z";
  await testEnv.DB
    .prepare("INSERT INTO ingest_window (id, opened_at, closed_at, bytes, days, deadline, total_bytes) VALUES (1, ?, NULL, ?, 0, ?, ?)")
    .bind(opened, bytes, deadline, total)
    .run();
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

describe("auth and daily limit translation", () => {
  it("never accepts an empty ingest secret", () => {
    const request = new Request("https://health-mcp.test/summary", { headers: { authorization: "Bearer test-token" } });
    expect(authed(request, "")).toBe(false);
    expect(authed(request, "   ")).toBe(false);
    expect(authed(request, undefined)).toBe(false);
    expect(authed(new Request("https://health-mcp.test/summary", { headers: { authorization: "Bearer " } }), "test-token")).toBe(false);
    expect(authed(request, "test-token")).toBe(true);
  });

  it("classifies a nested D1 daily limit and tells the client to wait until UTC midnight", async () => {
    expect(d1DailyLimitKind(new Error("wrapper", { cause: new Error("db", { cause: READ_LIMIT }) }))).toBe("d1_rows_read");
    expect(d1DailyLimitKind(new Error(`${WRITE_LIMIT}\n${READ_LIMIT}`))).toBe("d1_rows_written");
    expect(d1DailyLimitKind(new Error("SQLITE_BUSY"))).toBeNull();

    const now = new Date("2024-06-01T23:00:00.000Z");
    expect(secondsUntilNextUtcMidnight(now)).toBe(3600);
    expect(secondsUntilNextUtcMidnight(new Date("2024-06-01T23:59:59.200Z"))).toBe(1);
    const response = dailyLimitResponse("d1_rows_written", now);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "daily_limit", limit_hit: "d1_rows_written" });
  });
});

describe("import byte budget", () => {
  it("rejects a post the receipt total cannot afford even when the window row still shows room", async () => {
    const deadline = new Date(Date.now() + 72 * 3_600_000).toISOString();
    const total = 10_000;
    await seedWindow(0, total, deadline);
    const payload = stepPost("2020-06-01", 7);
    const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    expect(size).toBeLessThan(total);
    await testEnv.DB
      .prepare("INSERT INTO ingest_receipt (id, window_start, bytes, days, touch_window) VALUES ('seed-budget', 0, ?, 1, 1)")
      .bind(total - size + 1)
      .run();

    const blocked = await postJson("/ingest", payload);
    expect(blocked.status, await blocked.clone().text()).toBe(413);
    expect(await blocked.json<{ error: string; message: string }>()).toMatchObject({
      error: "payload_too_large",
      message: expect.stringContaining("initial import total"),
    });
    expect(await testEnv.DB.prepare("SELECT qty FROM samples WHERE qty = 7").first()).toBeNull();
    expect(await count("ingest_receipt")).toBe(1);
    expect(await windowRow()).toMatchObject({ bytes: 0, closed_at: null });

    await testEnv.DB.prepare("UPDATE ingest_receipt SET bytes = ? WHERE id = 'seed-budget'").bind(total - size).run();
    const admitted = await postJson("/ingest", payload);
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    const admittedBody = await admitted.json<{ samples: number; backfill: { open: boolean; bytes_remaining: number } }>();
    expect(admittedBody.samples).toBe(1);
    expect(admittedBody.backfill).toMatchObject({ open: false, bytes_remaining: 0 });
    expect(await testEnv.DB.prepare("SELECT qty FROM samples WHERE qty = 7").first<{ qty: number }>()).toEqual({ qty: 7 });
    expect((await windowRow())?.bytes).toBe(total);
  });

  it("stops historic dates once the recorded byte total is spent, and still stores today", async () => {
    const deadline = new Date(Date.now() + 72 * 3_600_000).toISOString();
    await seedWindow(1_000, 1_000, deadline);
    const today = utcDay(0);

    const historic = await postJson("/ingest", stepPost("2015-03-03", 11));
    expect(historic.status, await historic.clone().text()).toBe(422);
    expect(await historic.json<{ error: string; message: string }>()).toMatchObject({
      error: "outside_window",
      message: expect.stringContaining("initial import window is closed"),
    });
    expect(await count("samples")).toBe(0);

    const current = await postJson("/ingest", stepPost(today, 12, "09"));
    expect(current.status, await current.clone().text()).toBe(200);
    expect(await testEnv.DB.prepare("SELECT date, qty FROM samples").first()).toEqual({ date: today, qty: 12 });
    expect(await windowRow()).toMatchObject({ bytes: 1_000, closed_at: null });
  });

  it("treats a past deadline as closed while closed_at is still null", async () => {
    await seedWindow(0, 500_000_000, "2020-01-02T00:00:00.000Z");
    const today = utcDay(0);

    const historic = await postJson("/ingest", stepPost("2016-04-04", 13));
    expect(historic.status, await historic.clone().text()).toBe(422);
    expect(await count("samples")).toBe(0);
    expect(await count("ingest_receipt")).toBe(0);

    expect((await postJson("/ingest", stepPost(today, 14, "10"))).status).toBe(200);
    expect(await testEnv.DB.prepare("SELECT date, qty FROM samples").first()).toEqual({ date: today, qty: 14 });
    expect(await windowRow()).toMatchObject({ bytes: 0, closed_at: null, total_bytes: 500_000_000 });
  });
});

describe("ingest payload gates", () => {
  it("rejects more than 366 dates before opening the window, and stores a 366-date chunk", async () => {
    const tooMany = Array.from({ length: 367 }, (_, index) => addDays("2000-01-01", index));
    const rejected = await postJson("/ingest", stepsOn(tooMany));
    expect(rejected.status, await rejected.clone().text()).toBe(413);
    const rejectedBody = await rejected.json<{ error: string; message: string }>();
    expect(rejectedBody.error).toBe("payload_too_large");
    expect(rejectedBody.message).toContain("366");
    expect(await count("samples")).toBe(0);
    expect(await count("ingest_window")).toBe(0);
    expect(await count("ingest_receipt")).toBe(0);

    const acceptedDates = tooMany.slice(0, 366);
    const accepted = await postJson("/ingest", stepsOn(acceptedDates, 2));
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const acceptedBody = await accepted.json<{ samples: number; dates: string[] }>();
    expect(acceptedBody.samples).toBe(366);
    expect(acceptedBody.dates).toEqual(acceptedDates);
    expect(await count("samples")).toBe(366);
    expect(await count("ingest_window")).toBe(1);
  }, 30_000);

  it("stores the last chunk when backfill done arrives with data, and a done header closes without that body", async () => {
    const stored = await postJson("/ingest", { ...stepPost("2020-05-05", 42, "08"), backfill: "done" });
    expect(stored.status, await stored.clone().text()).toBe(200);
    const storedBody = await stored.json<{ samples: number; backfill: { open: boolean } }>();
    expect(storedBody).toMatchObject({ samples: 1, backfill: { open: false } });
    expect(await testEnv.DB.prepare("SELECT qty FROM samples WHERE qty = 42").first<{ qty: number }>()).toEqual({ qty: 42 });
    expect((await windowRow())?.closed_at).toBeTruthy();

    const afterClose = await postJson("/ingest", stepPost("2014-01-01", 1));
    expect(afterClose.status).toBe(422);
    expect(await count("samples")).toBe(1);

    await testEnv.DB.batch([
      testEnv.DB.prepare("DELETE FROM samples"),
      testEnv.DB.prepare("DELETE FROM ingest_window"),
      testEnv.DB.prepare("DELETE FROM ingest_receipt"),
    ]);
    const header = await postJson("/ingest", stepPost("2020-05-06", 99, "09"), { "x-backfill": "DONE" });
    expect(header.status, await header.clone().text()).toBe(200);
    expect(await header.json<{ samples: number; backfill: { open: boolean } }>()).toMatchObject({ samples: 0, backfill: { open: false } });
    expect(await testEnv.DB.prepare("SELECT qty FROM samples WHERE qty = 99").first()).toBeNull();
    expect((await windowRow())?.closed_at).toBeTruthy();
  });

  it("rejects a steady-state body over 1 MB before parsing it", async () => {
    const today = utcDay(0);
    expect((await postJson("/ingest", stepPost(today, 3, "08"))).status).toBe(200);
    expect((await postJson("/ingest", { backfill: "done" })).status).toBe(200);
    const receipts = await count("ingest_receipt");

    const oversized = await authedFetch("/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1_000_001) });
    expect(oversized.status, await oversized.clone().text()).toBe(413);
    expect(await oversized.json<{ error: string; message: string }>()).toMatchObject({
      error: "payload_too_large",
      message: expect.stringContaining("1000000"),
    });
    expect(await count("ingest_receipt")).toBe(receipts);
    expect((await testEnv.DB.prepare("SELECT qty FROM samples").all<{ qty: number }>()).results).toEqual([{ qty: 3 }]);

    expect((await postJson("/ingest", stepPost(today, 4, "11"))).status).toBe(200);
    const rows = await testEnv.DB.prepare("SELECT qty FROM samples ORDER BY qty").all<{ qty: number }>();
    expect(rows.results).toEqual([{ qty: 3 }, { qty: 4 }]);
  });

  it("rejects JSON, markdown, and a non-array metric list without opening the window", async () => {
    const json = await authedFetch("/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(json.status).toBe(400);
    expect(await json.json<{ error: string }>()).toEqual({ error: "invalid_json", backfill: { open: false, closes_at: null, bytes_remaining: 0 } });

    const markdown = await authedFetch("/ingest", { method: "POST", headers: { "content-type": "text/markdown" }, body: "# steps" });
    expect(markdown.status).toBe(415);
    expect(await markdown.json<{ error: string }>()).toMatchObject({ error: "unsupported_media_type" });

    const shape = await postJson("/ingest", { data: { metrics: { name: "step_count" } } });
    expect(shape.status).toBe(400);
    expect(await shape.json<{ error: string }>()).toMatchObject({ error: "invalid_payload" });
    expect(await count("ingest_window")).toBe(0);
    expect(await count("samples")).toBe(0);
  });

  it("records the export hint at 50 stale days and not at 49", async () => {
    const today = utcDay(0);
    expect((await postJson("/ingest", stepPost(today, 1, "08"))).status).toBe(200);
    expect((await postJson("/ingest", { backfill: "done" })).status).toBe(200);

    const fortyNine = Array.from({ length: 49 }, (_, index) => addDays("2010-01-01", index));
    const below = await postJson("/ingest", stepsOn([...fortyNine, today], 5));
    expect(below.status, await below.clone().text()).toBe(200);
    expect(await below.json<{ dropped_stale: number }>()).toMatchObject({ dropped_stale: 49 });
    const quiet = await (await authedFetch(`/summary?date=${today}`)).json<{ export_hint?: string; steps: number }>();
    expect(quiet.export_hint).toBeUndefined();
    expect(quiet.steps).toBeGreaterThan(0);

    const fifty = Array.from({ length: 50 }, (_, index) => addDays("2011-01-01", index));
    const atHint = await postJson("/ingest", stepsOn([...fifty, today], 6));
    expect(atHint.status, await atHint.clone().text()).toBe(200);
    expect(await atHint.json<{ dropped_stale: number }>()).toMatchObject({ dropped_stale: 50 });
    const hinted = await (await authedFetch(`/summary?date=${today}`)).json<{ export_hint?: string }>();
    expect(hinted.export_hint).toContain("misconfigured");
    const stale = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM samples WHERE date < '2020-01-01'").first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });
});

describe("apple chunk validation", () => {
  it("does not delete stored rows when the chunk is not valid", async () => {
    await testEnv.DB
      .prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind, extra) VALUES ('keep-me', 'step_count', '2020-08-01', '2020-08-01 00:00:00', 'Apple Watch', 15, 'count', 'sum', '{\"apple\":true}')",
      )
      .run();

    const broken = await authedFetch("/import/apple-health/chunk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"samples\":",
    });
    expect(broken.status).toBe(400);
    expect(await broken.json<{ error: string }>()).toEqual({ error: "invalid_json" });

    const badKey = await postJson("/import/apple-health/chunk", {
      samples: [{
        metric: "step_count",
        date: "2020-08-01",
        start_ts: "2020-08-01 12:00:00 +0000",
        source: "Apple Watch",
        qty: 1,
        units: "count",
        kind: "sum",
        series_key: "series/../../secrets",
      }],
      workouts: [],
      events: [],
      series: [{ key: "not-a-key", body: { voltageMeasurements: [1] } }],
    });
    expect(badKey.status, await badKey.clone().text()).toBe(400);
    expect(await badKey.json<{ error: string }>()).toEqual({ error: "invalid_payload" });
    expect(await testEnv.DB.prepare("SELECT qty FROM samples WHERE id = 'keep-me'").first<{ qty: number }>()).toEqual({ qty: 15 });
    expect((await testEnv.SERIES.list()).objects).toEqual([]);
    expect(await count("ingest_window")).toBe(0);
    expect(await count("ingest_receipt")).toBe(0);

    const valid = await postJson("/import/apple-health/chunk", {
      samples: [{
        metric: "step_count",
        date: "2020-08-02",
        start_ts: "2020-08-02 12:00:00 +0000",
        source: "Apple Watch",
        qty: 4,
        units: "count",
        kind: "sum",
      }],
      workouts: [],
      events: [],
    });
    expect(valid.status, await valid.clone().text()).toBe(200);
    const kept = await testEnv.DB.prepare("SELECT date, qty FROM samples ORDER BY date").all<{ date: string; qty: number }>();
    expect(kept.results).toEqual([
      { date: "2020-08-01", qty: 15 },
      { date: "2020-08-02", qty: 4 },
    ]);
    expect(await count("ingest_window")).toBe(0);
  });
});

describe("summary and rollup math", () => {
  it("keeps the latest weight, scales a body-fat fraction, and ignores Apple steps when a live row exists", async () => {
    const day = "2024-04-01";
    const next = "2024-04-02";
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('w-early', 'weight_body_mass', ?, '2024-04-01 08:00:00', 'Scale', 80, 'kg', 'latest')",
      ).bind(day),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('w-late', 'weight_body_mass', ?, '2024-04-01 21:00:00', 'Scale', 70.5, 'kg', 'latest')",
      ).bind(day),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('fat', 'body_fat_percentage', ?, '2024-04-01 21:00:00', 'Scale', 0.2, '%', 'latest')",
      ).bind(day),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('steps-a', 'step_count', ?, '2024-04-01 08:00:00', 'iPhone', 100, 'count', 'sum')",
      ).bind(day),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('steps-b', 'step_count', ?, '2024-04-01 18:00:00', 'iPhone', 25, 'count', 'sum')",
      ).bind(day),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind, extra) VALUES ('steps-apple', 'step_count', ?, '2024-04-01 00:00:00', 'Apple Watch', 9999, 'count', 'sum', '{\"apple\":true}')",
      ).bind(day),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('fat-whole', 'body_fat_percentage', ?, '2024-04-02 08:00:00', 'Scale', 22, '%', 'latest')",
      ).bind(next),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('fat-one', 'body_fat_percentage', '2024-04-03', '2024-04-03 08:00:00', 'Scale', 1, '%', 'latest')",
      ),
    ]);

    const first = await (await authedFetch(`/summary?date=${day}`)).json<{
      steps: number;
      weight: { value: number; units: string };
      body_fat_pct: number;
    }>();
    expect(first).toMatchObject({ steps: 125, weight: { value: 70.5, units: "kg" }, body_fat_pct: 20 });
    expect(await (await authedFetch(`/summary?date=${next}`)).json<{ body_fat_pct: number }>()).toMatchObject({ body_fat_pct: 22 });
    expect(await (await authedFetch("/summary?date=2024-04-03")).json<{ body_fat_pct: number }>()).toMatchObject({ body_fat_pct: 100 });
  });

  it("averages blood pressure, keeps the latest reading, and flags a short day limit", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty_min, qty_max, units, kind) VALUES ('bp-1', 'blood_pressure', '2024-05-01', '2024-05-01 08:00:00', '', 80, 120, 'mmHg', 'blood_pressure')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty_min, qty_max, units, kind) VALUES ('bp-2', 'blood_pressure', '2024-05-01', '2024-05-01 20:00:00', '', 90, 140, 'mmHg', 'blood_pressure')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('mass-1', 'weight_body_mass', '2024-05-02', '2024-05-02 08:00:00', '', 80, 'kg', 'latest')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('mass-2', 'weight_body_mass', '2024-05-02', '2024-05-02 21:00:00', '', 72, 'kg', 'latest')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('d1', 'step_count', '2024-06-01', '2024-06-01 00:00:00', '', 1, 'count', 'sum')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('d2', 'step_count', '2024-06-02', '2024-06-02 00:00:00', '', 2, 'count', 'sum')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO samples (id, metric, date, start_ts, source, qty, units, kind) VALUES ('d3', 'step_count', '2024-06-03', '2024-06-03 00:00:00', '', 3, 'count', 'sum')",
      ),
    ]);

    const pressure = await metricRollup(testEnv.DB, "blood_pressure", "2024-05-01", "2024-05-01", 500);
    expect(pressure).toMatchObject({ kind: "blood_pressure", truncated: false, rows: [{ date: "2024-05-01", systolic: 130, diastolic: 85, units: "mmHg" }] });

    const weight = await metricRollup(testEnv.DB, "weight_body_mass", "2024-05-02", "2024-05-02", 500);
    expect(weight).toMatchObject({ kind: "latest", truncated: false, rows: [{ date: "2024-05-02", qty: 72, units: "kg" }] });
    expect(JSON.stringify(weight.rows)).not.toContain("152");

    const steps = await metricRollup(testEnv.DB, "step_count", "2024-06-01", "2024-06-03", 2);
    expect(steps.truncated).toBe(true);
    expect(steps.rows).toEqual([
      { date: "2024-06-01", qty: 1, units: "count" },
      { date: "2024-06-02", qty: 2, units: "count" },
    ]);
  });
});

describe("MCP read bounds", () => {
  it("rejects a browser origin, a range past 366 days, and a series page that is not a stored key", async () => {
    const denied = await SELF.fetch("https://health-mcp.test/mcp", {
      method: "POST",
      headers: { authorization: TOKEN, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json<{ error: string }>()).toEqual({ error: "origin_not_allowed" });

    const ingest = await postJson("/ingest", stepPost("2020-07-07", 8), { origin: "https://evil.example" });
    expect(ingest.status, await ingest.clone().text()).toBe(200);
    const summary = await authedFetch("/summary?date=2020-07-07", { headers: { origin: "https://evil.example" } });
    expect(summary.status).toBe(200);

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
    expect(initialize.status, await initialize.clone().text()).toBe(200);
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
        ? JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5)) as { result: ToolResult }
        : JSON.parse(text) as { result: ToolResult };
      return payload.result;
    }

    const backwards = await callTool("query_metrics", { metric: "step_count", start_date: "2024-05-02", end_date: "2024-05-01" });
    expect(backwards.isError).toBe(true);
    expect(JSON.stringify(backwards)).toContain("start_date first");

    const impossible = await callTool("query_metrics", { metric: "step_count", start_date: "2024-02-31", end_date: "2024-03-01" });
    expect(impossible.isError).toBe(true);

    const tooWide = await callTool("query_metrics", { metric: "step_count", start_date: "2024-01-01", end_date: "2025-01-02" });
    expect(tooWide.isError).toBe(true);
    expect(JSON.stringify(tooWide)).toContain("366");

    const exact = await callTool("query_metrics", { metric: "step_count", start_date: "2024-01-01", end_date: "2025-01-01" });
    expect(exact.isError).toBeFalsy();
    expect(exact.structuredContent).toMatchObject({ truncated: false, rows: [] });

    const key = `series/${"ab".repeat(16)}`;
    const voltage = Array.from({ length: 501 }, (_, index) => index);
    await testEnv.SERIES.put(key, JSON.stringify({ voltageMeasurements: voltage, note: "keep" }));

    const firstPage = await callTool("get_series", { key, part: "voltageMeasurements" });
    expect(firstPage.isError).toBeFalsy();
    const first = firstPage.structuredContent as { items: number[]; truncated: boolean; offset: number };
    expect(first.offset).toBe(0);
    expect(first.truncated).toBe(true);
    expect(first.items).toHaveLength(500);
    expect(first.items[0]).toBe(0);
    expect(first.items[499]).toBe(499);

    const lastPage = await callTool("get_series", { key, part: "voltageMeasurements", offset: 500 });
    expect(lastPage.structuredContent).toMatchObject({ offset: 500, truncated: false, items: [500] });

    const missingPart = await callTool("get_series", { key, part: "note" });
    expect(missingPart.isError).toBe(true);
    expect(JSON.stringify(missingPart)).toContain("unknown_part");

    const catalog = await callTool("get_series", { key });
    expect(JSON.stringify(catalog.structuredContent)).toContain("voltageMeasurements");

    for (const bad of ["../secret", "series/ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", `series/${"0".repeat(32)}`]) {
      const missing = await callTool("get_series", { key: bad });
      expect(missing.isError, bad).toBe(true);
      expect(JSON.stringify(missing)).toContain("unknown_series");
    }
  });
});

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { text: string }[];
}
