-- Operational alerts. The alerts scheduler raises rows here when something
-- needs ops attention:
--   approval_sla    — a change has been in 'submitted' past the configured
--                     threshold (default 24h) without an approve/reject
--   recurring_drift — a recurring parent's last fire is older than the
--                     last expected fire from its cron schedule, by more
--                     than a small tolerance — usually means the scheduler
--                     was down or a fire failed silently
--
-- Each (kind, subject) is single-active: once raised, we don't re-raise
-- until the condition clears (resolved_at is set). If it recurs later,
-- a new row is inserted.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('approval_sla', 'recurring_drift')),
  subject_change_id INTEGER,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  notified_at TEXT,
  details_json TEXT,
  FOREIGN KEY (subject_change_id) REFERENCES changes(id) ON DELETE CASCADE
);

CREATE INDEX idx_alerts_kind_subject ON alerts(kind, subject_change_id);
CREATE INDEX idx_alerts_unresolved   ON alerts(kind, subject_change_id) WHERE resolved_at IS NULL;
