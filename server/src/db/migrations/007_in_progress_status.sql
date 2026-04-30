-- @no-tx
-- Add 'in_progress' as a status between 'approved' and 'implemented'.
-- SQLite can't ALTER a CHECK constraint in place, so we rebuild the table.
-- This migration manages its own transaction because PRAGMA foreign_keys
-- can't be toggled inside one.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE changes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'in_progress', 'rejected', 'implemented', 'closed', 'rolled_back')),
  submitter_id INTEGER NOT NULL,
  scheduled_at TEXT,
  submitted_at TEXT,
  in_progress_at TEXT,
  implemented_at TEXT,
  closed_at TEXT,
  planned_duration_minutes INTEGER,
  actual_duration_minutes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(submitter_id) REFERENCES users(id)
);

INSERT INTO changes_new
  (id, type_key, title, description, fields_json, status, submitter_id, scheduled_at,
   submitted_at, implemented_at, closed_at, planned_duration_minutes, actual_duration_minutes,
   created_at, updated_at)
SELECT
   id, type_key, title, description, fields_json, status, submitter_id, scheduled_at,
   submitted_at, implemented_at, closed_at, planned_duration_minutes, actual_duration_minutes,
   created_at, updated_at
FROM changes;

DROP TABLE changes;
ALTER TABLE changes_new RENAME TO changes;

CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status);
CREATE INDEX IF NOT EXISTS idx_changes_submitter ON changes(submitter_id);
CREATE INDEX IF NOT EXISTS idx_changes_type ON changes(type_key);

COMMIT;

PRAGMA foreign_keys = ON;
