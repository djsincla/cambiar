-- Per-user iCal subscription token. Calendar apps don't do interactive auth,
-- so we authenticate the GET /ical/upcoming.ics request via a token in the
-- query string. Users can regenerate it from the UI if they suspect it's
-- been shared too widely.
ALTER TABLE users ADD COLUMN ical_token TEXT;
CREATE UNIQUE INDEX idx_users_ical_token ON users(ical_token) WHERE ical_token IS NOT NULL;
