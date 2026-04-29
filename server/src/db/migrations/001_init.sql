CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  password_hash TEXT,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'ad')),
  role TEXT NOT NULL DEFAULT 'submitter' CHECK (role IN ('admin', 'approver', 'submitter')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'implemented', 'closed', 'rolled_back')),
  submitter_id INTEGER NOT NULL,
  scheduled_at TEXT,
  implemented_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(submitter_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status);
CREATE INDEX IF NOT EXISTS idx_changes_submitter ON changes(submitter_id);
CREATE INDEX IF NOT EXISTS idx_changes_type ON changes(type_key);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL,
  approver_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(change_id) REFERENCES changes(id) ON DELETE CASCADE,
  FOREIGN KEY(approver_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_change ON approvals(change_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(change_id) REFERENCES changes(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_change ON audit_log(change_id);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
