-- Notes: a chronological log of free-form text (markdown) attached to a
-- change. Anyone authed who can see the change can add notes; the author or
-- an admin can edit/delete.
CREATE TABLE IF NOT EXISTS change_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(change_id) REFERENCES changes(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_change_notes_change ON change_notes(change_id);

-- Attachments: file uploads belonging to a change. Stored on disk under
-- data/uploads/changes/<change_id>/<filename>; this table holds metadata
-- so the UI can render galleries and access controls.
CREATE TABLE IF NOT EXISTS change_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL,
  user_id INTEGER,
  filename TEXT NOT NULL,             -- random on-disk name, includes extension
  original_filename TEXT NOT NULL,    -- what the user uploaded
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(change_id) REFERENCES changes(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_change_attachments_change ON change_attachments(change_id);

-- Templates: reusable change blueprints. A template captures the type-key,
-- title, description, fields, and planned duration; it does NOT capture
-- notes or attachments (those are specific to a real change record). New
-- changes can be created from a template (or from another change) to
-- copy these fields into a fresh draft.
CREATE TABLE IF NOT EXISTS change_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  type_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body_description TEXT,              -- the change's description field; named to avoid clashing with this column 'description'
  fields_json TEXT NOT NULL DEFAULT '{}',
  planned_duration_minutes INTEGER,
  created_by_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(created_by_id) REFERENCES users(id) ON DELETE SET NULL
);
