import { Router } from 'express';
import { listEmailLog } from '../services/emailActions.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired, requireRole('admin'));

router.get('/', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const errorsOnly = req.query.errorsOnly === 'true';
  res.json({ entries: listEmailLog({ limit, offset, errorsOnly }) });
});

export default router;
