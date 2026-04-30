import { Router } from 'express';
import { z } from 'zod';
import {
  listRules, getRule, createRule, updateRule, deleteRule, validateRuleInput,
} from '../services/emailRules.js';
import { listEmailLog, processEmail } from '../services/emailActions.js';
import { pollOnce } from '../services/emailPoller.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired, requireRole('admin'));

const createSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  fromPattern: z.string().max(500).nullable().optional(),
  subjectPattern: z.string().max(500).nullable().optional(),
  actionType: z.enum(['create_change', 'transition', 'add_note']),
  actionConfig: z.record(z.any()).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  fromPattern: z.string().max(500).nullable().optional(),
  subjectPattern: z.string().max(500).nullable().optional(),
  actionType: z.enum(['create_change', 'transition', 'add_note']).optional(),
  actionConfig: z.record(z.any()).optional(),
}).strict();

router.get('/', (_req, res) => res.json({ rules: listRules() }));

router.get('/:id', (req, res) => {
  const r = getRule(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ rule: r });
});

router.post('/', (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });
  const err = validateRuleInput(parse.data);
  if (err) return res.status(400).json({ error: err });
  res.status(201).json({ rule: createRule(parse.data) });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getRule(id)) return res.status(404).json({ error: 'not found' });
  const parse = patchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });
  const err = validateRuleInput(parse.data, { partial: true });
  if (err) return res.status(400).json({ error: err });
  res.json({ rule: updateRule(id, parse.data) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getRule(id)) return res.status(404).json({ error: 'not found' });
  deleteRule(id);
  res.json({ ok: true });
});

// Test a rule against a synthetic email — useful during admin setup.
const testSchema = z.object({
  from: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
});

router.post('/:id/test', async (req, res) => {
  const r = getRule(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'not found' });
  const parse = testSchema.safeParse(req.body ?? {});
  if (!parse.success) return res.status(400).json({ error: 'invalid request' });
  const result = await processEmail({
    from: parse.data.from ?? '',
    subject: parse.data.subject ?? '',
    body: parse.data.body ?? '',
    messageId: `<test-${Date.now()}@cambiar.local>`,
    receivedAt: new Date().toISOString(),
  });
  res.json(result);
});

// Trigger a poll on demand.
router.post('/poll-now', async (_req, res) => {
  const result = await pollOnce();
  res.json(result);
});

export default router;
