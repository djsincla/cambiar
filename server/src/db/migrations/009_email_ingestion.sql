-- Inbound email ingestion: rules tell cambiar what to do with incoming
-- mail; the log records every processed message so admins can debug.

CREATE TABLE IF NOT EXISTS email_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,           -- lower number = checked first
  from_pattern TEXT,                               -- case-insensitive regex against From header
  subject_pattern TEXT,                            -- case-insensitive regex against Subject
  action_type TEXT NOT NULL CHECK (action_type IN ('create_change', 'transition', 'add_note')),
  action_config TEXT NOT NULL DEFAULT '{}',        -- JSON, schema depends on action_type
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_rules_enabled_priority ON email_rules(enabled, priority);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  from_addr TEXT,
  subject TEXT,
  received_at TEXT,
  matched_rule_id INTEGER,
  action_summary TEXT,
  error TEXT,
  change_id INTEGER,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(matched_rule_id) REFERENCES email_rules(id) ON DELETE SET NULL,
  FOREIGN KEY(change_id) REFERENCES changes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_email_log_processed_at ON email_log(processed_at);
CREATE INDEX IF NOT EXISTS idx_email_log_message_id ON email_log(message_id);

-- The synthetic 'email-system' user owns email-created changes.
-- active=0 prevents login (and the password hash is random bytes —
-- nobody can log in as this user). It exists purely so the FK on
-- changes.submitter_id has a target for ingested rows.
INSERT OR IGNORE INTO users (username, display_name, source, role, active, password_hash)
VALUES (
  'email-system',
  'System (email ingestion)',
  'local',
  'submitter',
  0,
  -- placeholder bcrypt-shaped hash: not a valid password hash, intentionally.
  '$2b$12$EmailSystemPlaceholderNotARealHashIntentionallyInvalidXXXXX'
);
