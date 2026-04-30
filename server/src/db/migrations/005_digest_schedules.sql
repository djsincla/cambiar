-- Scheduled digest emails. Each row defines a recurring job (cron expression
-- + timezone) that pulls changes scheduled in a forward-looking window and
-- emails a digest. recipients are stored as JSON arrays of user IDs and
-- free-form email strings; both are unioned at send time.

CREATE TABLE IF NOT EXISTS digest_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  lookahead_days INTEGER NOT NULL DEFAULT 7,
  status_filter TEXT NOT NULL DEFAULT '[]',
  recipient_user_ids TEXT NOT NULL DEFAULT '[]',
  recipient_emails TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_digest_schedules_enabled ON digest_schedules(enabled);
