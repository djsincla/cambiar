-- Login-attempt audit + account-lockout state.
--
-- auth_events: every login attempt (success or failure) logs a row. Lets
-- admins see "5 failed attempts on user 'admin' from 10.x.x.x in the last
-- 10 min" without grepping logs. The username is recorded as TRIED — even
-- if no user by that name exists — so password-spray patterns are visible.
--
-- users.locked_until: ISO timestamp; if NOT NULL and in the future, the
-- account is currently locked. Cleared by login success, by an admin via
-- POST /api/auth/clear-lock/:username, or by reset-admin CLI.
CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'success',
    'invalid_credentials',
    'account_disabled',
    'account_locked',
    'ad_unavailable',
    'allowlist_rejected'
  )),
  source TEXT NOT NULL CHECK (source IN ('local', 'ad', 'unknown')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Compound indexes on the read patterns the lockout check + admin list use:
-- "recent failures for username X" and "recent events globally for the admin page".
CREATE INDEX idx_auth_events_username_recent ON auth_events(username, created_at);
CREATE INDEX idx_auth_events_recent ON auth_events(created_at);

ALTER TABLE users ADD COLUMN locked_until TEXT;
