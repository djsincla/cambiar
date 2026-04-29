import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import {
  listGroups, getGroupById, createGroup, updateGroup, deleteGroup, setGroupMembers,
} from '../services/groups.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired);

router.get('/', (req, res) => {
  res.json({ groups: listGroups() });
});

router.get('/:id', (req, res) => {
  const g = getGroupById(Number(req.params.id));
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json({ group: g });
});

const createSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[A-Za-z0-9 ._-]+$/, 'invalid name'),
  description: z.string().max(1000).optional().nullable(),
  memberIds: z.array(z.number().int().positive()).optional(),
});

router.post('/', requireRole('admin'), (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });
  if (db.prepare('SELECT id FROM groups WHERE name = ?').get(parse.data.name)) {
    return res.status(409).json({ error: 'group name already exists' });
  }
  const g = createGroup(parse.data);
  if (parse.data.memberIds?.length) {
    setGroupMembers(g.id, parse.data.memberIds);
  }
  res.status(201).json({ group: getGroupById(g.id) });
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[A-Za-z0-9 ._-]+$/).optional(),
  description: z.string().max(1000).nullable().optional(),
  memberIds: z.array(z.number().int().positive()).optional(),
}).strict();

router.patch('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = getGroupById(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const parse = patchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  if (parse.data.name && parse.data.name !== existing.name) {
    if (db.prepare('SELECT id FROM groups WHERE name = ? AND id <> ?').get(parse.data.name, id)) {
      return res.status(409).json({ error: 'group name already exists' });
    }
  }
  updateGroup(id, parse.data);
  if ('memberIds' in parse.data) {
    setGroupMembers(id, parse.data.memberIds ?? []);
  }
  res.json({ group: getGroupById(id) });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = getGroupById(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // Group used as approver group on any change type? Refuse — admin must reassign first.
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM change_type_approver_groups WHERE group_id = ?').get(id).c;
  if (inUse > 0) {
    return res.status(409).json({ error: 'group is assigned as approver to one or more change types', count: inUse });
  }
  deleteGroup(id);
  res.json({ ok: true });
});

const memberSchema = z.object({ userId: z.number().int().positive() });

router.post('/:id/members', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!getGroupById(id)) return res.status(404).json({ error: 'not found' });
  const parse = memberSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(parse.data.userId)) {
    return res.status(400).json({ error: 'user does not exist' });
  }
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(parse.data.userId, id);
  res.json({ group: getGroupById(id) });
});

router.delete('/:id/members/:userId', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!getGroupById(id)) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM user_groups WHERE group_id = ? AND user_id = ?').run(id, userId);
  res.json({ group: getGroupById(id) });
});

export default router;
