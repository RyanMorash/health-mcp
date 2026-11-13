-- Fresh schema for the Workers-only rebuild.
-- This does not upgrade a database that already applied the 0.1 migrations.
-- Create a new D1 database instead of reusing the old one.

CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  date TEXT NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT,
  source TEXT NOT NULL DEFAULT '',
  qty REAL,
  qty_min REAL,
  qty_avg REAL,
  qty_max REAL,
  units TEXT,
  label TEXT,
  extra TEXT,
  kind TEXT NOT NULL,
  series_key TEXT
);
CREATE INDEX samples_metric_date ON samples(metric, date);

CREATE TABLE workouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT,
  date TEXT NOT NULL,
  duration_s REAL,
  active_kcal REAL,
  total_kcal REAL,
  distance_qty REAL,
  distance_units TEXT,
  hr_min REAL,
  hr_avg REAL,
  hr_max REAL,
  location TEXT,
  source TEXT,
  summary TEXT,
  series_key TEXT
);
CREATE INDEX workouts_date ON workouts(date);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subtype TEXT,
  start_ts TEXT NOT NULL,
  end_ts TEXT,
  date TEXT NOT NULL,
  source TEXT,
  payload TEXT NOT NULL,
  series_key TEXT
);
CREATE INDEX events_kind_date ON events(kind, date);

CREATE TABLE ingest_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  total_bytes INTEGER
);

CREATE TABLE ingest_receipt (
  id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  touch_window INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ingest_receipt_window ON ingest_receipt(window_start);

CREATE TABLE export_hint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hint TEXT
);
