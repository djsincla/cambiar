-- Push-only Google Calendar sync. Each change that's scheduled and in a
-- "publish to calendar" state gets a corresponding event written via the
-- Google Calendar API by a background reconciler. We stash the Google
-- event id back on the change row so subsequent updates / deletes know
-- which event to touch.
--
-- gcal_event_id   — set after the event is successfully created. NULL
--                   means either: never synced, or sync is disabled, or
--                   the change is in a non-publishable state.
-- gcal_synced_at  — last successful reconcile pass. The reconciler picks
--                   up changes whose updated_at > gcal_synced_at, plus
--                   newly-eligible ones whose gcal_synced_at is NULL.
ALTER TABLE changes ADD COLUMN gcal_event_id TEXT;
ALTER TABLE changes ADD COLUMN gcal_synced_at TEXT;

CREATE INDEX idx_changes_gcal_pending ON changes(updated_at)
  WHERE scheduled_at IS NOT NULL AND is_recurring_parent = 0;
