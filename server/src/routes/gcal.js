import { Router } from 'express';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { gcalStatus } from '../services/googleCalendar.js';
import { runSync } from '../services/gcalSync.js';
import { db } from '../db/index.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired, requireRole('admin'));

router.get('/status', (_req, res) => {
  // Counter snapshot — how many changes are eligible, how many published.
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN gcal_event_id IS NOT NULL THEN 1 ELSE 0 END)              AS published,
      SUM(CASE WHEN scheduled_at IS NOT NULL AND is_recurring_parent = 0
               AND status IN ('submitted','approved','in_progress','implemented')
               THEN 1 ELSE 0 END)                                              AS eligible,
      SUM(CASE WHEN gcal_synced_at IS NULL AND scheduled_at IS NOT NULL
               AND is_recurring_parent = 0 THEN 1 ELSE 0 END)                  AS never_synced
    FROM changes
  `).get();
  res.json({
    ...gcalStatus(),
    counts: {
      published: Number(counts.published) || 0,
      eligible: Number(counts.eligible) || 0,
      neverSynced: Number(counts.never_synced) || 0,
    },
  });
});

router.post('/sync-now', async (_req, res) => {
  const result = await runSync();
  res.status(result.ok ? 200 : 503).json(result);
});

export default router;
