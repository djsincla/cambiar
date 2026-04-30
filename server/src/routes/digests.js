import { Router } from 'express';
import { z } from 'zod';
import {
  listSchedules, getSchedule, createSchedule, updateSchedule, deleteSchedule,
  validateScheduleInput,
} from '../services/digestSchedules.js';
import { runDigest } from '../services/digestRenderer.js';
import { registerSchedule, unregisterSchedule } from '../services/digestScheduler.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired, requireRole('admin'));

const STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'implemented', 'closed', 'rolled_back'];

const createSchema = z.object({
  name: z.string().min(1).max(120),
  cronExpression: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).default('UTC'),
  lookaheadDays: z.number().int().min(1).max(365).default(7),
  statusFilter: z.array(z.enum(STATUSES)).default([]),
  recipientUserIds: z.array(z.number().int().positive()).default([]),
  recipientEmails: z.array(z.string().email()).default([]),
  enabled: z.boolean().default(true),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  cronExpression: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  lookaheadDays: z.number().int().min(1).max(365).optional(),
  statusFilter: z.array(z.enum(STATUSES)).optional(),
  recipientUserIds: z.array(z.number().int().positive()).optional(),
  recipientEmails: z.array(z.string().email()).optional(),
  enabled: z.boolean().optional(),
}).strict();

router.get('/', (_req, res) => {
  res.json({ schedules: listSchedules() });
});

router.get('/:id', (req, res) => {
  const s = getSchedule(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ schedule: s });
});

router.post('/', (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const err = validateScheduleInput(parse.data);
  if (err) return res.status(400).json({ error: err });

  const created = createSchedule(parse.data);
  registerSchedule(created);
  res.status(201).json({ schedule: created });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getSchedule(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const parse = patchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const err = validateScheduleInput(parse.data, { partial: true });
  if (err) return res.status(400).json({ error: err });

  const updated = updateSchedule(id, parse.data);
  // Hot-swap the cron job: unregister, then re-register if still enabled.
  registerSchedule(updated);
  res.json({ schedule: updated });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getSchedule(id)) return res.status(404).json({ error: 'not found' });
  unregisterSchedule(id);
  deleteSchedule(id);
  res.json({ ok: true });
});

router.post('/:id/run-now', async (req, res) => {
  const id = Number(req.params.id);
  const s = getSchedule(id);
  if (!s) return res.status(404).json({ error: 'not found' });

  const result = await runDigest(s);
  res.status(result.ok ? 200 : 500).json(result);
});

export default router;
