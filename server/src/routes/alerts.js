import { Router } from 'express';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { listAlerts, resolveAlert, runAlertChecks, activeAlertCount } from '../services/alerts.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired);

// Lightweight count for the topbar badge — available to any authed user so
// approvers and admins can both see if there's anything outstanding.
router.get('/count', (_req, res) => {
  res.json({ active: activeAlertCount() });
});

router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const status = String(req.query.status ?? 'active');
  res.json({ alerts: listAlerts({ status }) });
});

router.post('/check-now', async (_req, res) => {
  const result = await runAlertChecks();
  res.json(result);
});

router.post('/:id/resolve', (req, res) => {
  const id = Number(req.params.id);
  const ok = resolveAlert(id);
  if (!ok) return res.status(404).json({ error: 'not found or already resolved' });
  res.json({ ok: true });
});

export default router;
