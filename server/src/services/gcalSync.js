// Push-only Google Calendar reconciler.
//
// On each pass:
//   - Eligible changes (scheduled, non-parent, status in publishable set,
//     local row is newer than the last successful sync) are inserted /
//     updated.
//   - Changes that previously had a Google event but are now in a
//     non-publishable state (draft, closed, rejected, rolled_back) have
//     their event deleted.
//
// All side-effects are best-effort: a failure on one change is logged and
// doesn't block the rest of the pass. The reconciler can be re-run
// safely — the work is idempotent because we track gcal_event_id and
// gcal_synced_at on the change row.

import { db } from '../db/index.js';
import { logger } from '../logger.js';
import {
  gcalEnabled, insertEvent, updateEvent, deleteEvent,
} from './googleCalendar.js';

const PUBLISH_STATUSES = new Set(['submitted', 'approved', 'in_progress', 'implemented']);

/**
 * Run a sync pass. Returns counters so callers (admin sync-now, scheduler)
 * can log/report what happened.
 *
 * Selection rule:
 *   - changes with scheduled_at NOT NULL and is_recurring_parent = 0, AND
 *   - either gcal_synced_at IS NULL (never synced)
 *     OR updated_at > gcal_synced_at (local edit since last sync)
 *     OR (status not in publish set) AND gcal_event_id IS NOT NULL
 *        (we left an event up there for a now-non-publishable change)
 *
 * Bounded LIMIT keeps a single pass cheap on a startup catch-up.
 */
export async function runSync({ limit = 200 } = {}) {
  const counters = { inserted: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
  if (!gcalEnabled()) return { ok: false, reason: 'gcal disabled or unconfigured', ...counters };

  const candidates = db.prepare(`
    SELECT id, type_key, title, description, status, scheduled_at,
           planned_duration_minutes, gcal_event_id, gcal_synced_at, updated_at
    FROM changes
    WHERE scheduled_at IS NOT NULL
      AND is_recurring_parent = 0
      AND (
        gcal_synced_at IS NULL
        OR updated_at > gcal_synced_at
        OR (status NOT IN ('submitted','approved','in_progress','implemented') AND gcal_event_id IS NOT NULL)
      )
    ORDER BY id ASC
    LIMIT ?
  `).all(limit);

  for (const c of candidates) {
    try {
      if (PUBLISH_STATUSES.has(c.status)) {
        if (c.gcal_event_id) {
          await updateEvent(c.gcal_event_id, c);
          counters.updated++;
        } else {
          const eventId = await insertEvent(c);
          db.prepare('UPDATE changes SET gcal_event_id = ? WHERE id = ?').run(eventId, c.id);
          counters.inserted++;
        }
      } else {
        // Non-publishable now (draft/closed/rejected/rolled_back). If we
        // had an event up there, take it down.
        if (c.gcal_event_id) {
          await deleteEvent(c.gcal_event_id);
          db.prepare('UPDATE changes SET gcal_event_id = NULL WHERE id = ?').run(c.id);
          counters.deleted++;
        } else {
          counters.skipped++;
        }
      }
      // Mark synced regardless of branch — we did the work for this row.
      db.prepare(`UPDATE changes SET gcal_synced_at = datetime('now') WHERE id = ?`).run(c.id);
    } catch (err) {
      counters.errors++;
      logger.warn({ err: err.message, changeId: c.id, eventId: c.gcal_event_id }, 'gcal sync error for change');
      // Don't update gcal_synced_at — we'll retry on the next pass.
    }
  }

  return { ok: true, ...counters };
}
