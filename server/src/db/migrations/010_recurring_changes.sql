-- Recurring changes: a change can be marked as a recurring 'parent' that
-- spawns child changes on a cron schedule. Each child has parent_change_id
-- pointing back so history is traceable.

ALTER TABLE changes ADD COLUMN parent_change_id INTEGER REFERENCES changes(id) ON DELETE SET NULL;
ALTER TABLE changes ADD COLUMN is_recurring_parent INTEGER NOT NULL DEFAULT 0;

-- Recurrence config (only meaningful when is_recurring_parent = 1).
ALTER TABLE changes ADD COLUMN recurrence_cron TEXT;
ALTER TABLE changes ADD COLUMN recurrence_timezone TEXT;
-- How far in the future the child's scheduled_at is set, relative to the
-- moment of cron fire. 0 = "right now", 10080 = "one week ahead".
ALTER TABLE changes ADD COLUMN recurrence_lead_minutes INTEGER NOT NULL DEFAULT 0;
-- If 1, the child is auto-submitted (and then auto-approved if the type is
-- auto-approve). If 0, the child stays in draft for manual review.
ALTER TABLE changes ADD COLUMN recurrence_auto_submit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE changes ADD COLUMN recurrence_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE changes ADD COLUMN recurrence_last_fired_at TEXT;

CREATE INDEX IF NOT EXISTS idx_changes_recurring_parent ON changes(is_recurring_parent);
CREATE INDEX IF NOT EXISTS idx_changes_parent_change ON changes(parent_change_id);
