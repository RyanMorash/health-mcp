-- Raw Health Auto Export samples, sleep, workout detail, and the other
-- automation payloads. Daily rows in points_daily stay the fast summary.
-- ADD COLUMN is skipped when the column is already present.

CREATE TABLE IF NOT EXISTS samples (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  ts TEXT NOT NULL,
  date TEXT NOT NULL,
  end_ts TEXT,
  qty REAL,
  min_qty REAL,
  max_qty REAL,
  avg_qty REAL,
  units TEXT,
  source TEXT,
  value TEXT,
  grain TEXT,
  extra TEXT,
  sig TEXT
);
CREATE INDEX IF NOT EXISTS samples_by_metric_date ON samples(metric, date);

CREATE TABLE IF NOT EXISTS sleep_sessions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_ts TEXT,
  end_ts TEXT,
  in_bed_start TEXT,
  in_bed_end TEXT,
  total_hr REAL,
  asleep_hr REAL,
  in_bed_hr REAL,
  core_hr REAL,
  deep_hr REAL,
  rem_hr REAL,
  awake_hr REAL,
  stage TEXT,
  source TEXT,
  sig TEXT
);
CREATE INDEX IF NOT EXISTS sleep_by_date ON sleep_sessions(date);

ALTER TABLE workouts ADD COLUMN end_ts TEXT;
ALTER TABLE workouts ADD COLUMN source TEXT;
ALTER TABLE workouts ADD COLUMN detail TEXT;

CREATE TABLE IF NOT EXISTS health_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ts TEXT,
  date TEXT NOT NULL,
  name TEXT,
  source TEXT,
  payload TEXT NOT NULL,
  sig TEXT
);
CREATE INDEX IF NOT EXISTS health_records_by_kind_date ON health_records(kind, date);
