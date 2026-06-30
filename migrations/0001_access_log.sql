CREATE TABLE access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  email TEXT,
  path TEXT NOT NULL,
  key TEXT,
  status INTEGER,
  ip TEXT,
  user_agent TEXT,
  cf TEXT,
  meta TEXT
);

CREATE INDEX access_log_ts_idx ON access_log (ts);
CREATE INDEX access_log_email_ts_idx ON access_log (email, ts);
CREATE INDEX access_log_path_ts_idx ON access_log (path, ts);
