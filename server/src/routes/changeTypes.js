import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import {
  listChangeTypes, getChangeTypeByKey, getChangeTypeById,
  createChangeType, updateChangeType, softDeleteChangeType,
  validateFieldSchema,
} from '../services/changeTypes.js';
import { db } from '../db/index.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired);

router.get('/', (req, res) => {
  const includeInactive = req.user.role === 'admin' && req.query.includeInactive === 'true';
  const types = listChangeTypes({ activeOnly: !includeInactive });
  res.json({ types });
});

router.get('/:keyOrId', (req, res) => {
  const { keyOrId } = req.params;
  let type = /^\d+$/.test(keyOrId) ? getChangeTypeById(Number(keyOrId)) : getChangeTypeByKey(keyOrId);
  if (!type) return res.status(404).json({ error: 'unknown change type' });
  res.json({ type });
});

const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(120),
  type: z.enum(['string', 'text', 'number', 'select', 'boolean']),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const createSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'key must be lowercase a-z, 0-9, _').max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  icon: z.string().max(64).optional().nullable(),
  fields: z.array(fieldSchema).default([]),
  approverGroupIds: z.array(z.number().int().positive()).optional(),
  autoApprove: z.boolean().optional(),
  approvalSlaMinutes: z.number().int().positive().max(60 * 24 * 30).optional().nullable(),
});

function rejectAutoApproveWithGroups(autoApprove, approverGroupIds) {
  if (autoApprove && Array.isArray(approverGroupIds) && approverGroupIds.length > 0) {
    return 'autoApprove is mutually exclusive with approverGroupIds — auto-approved types skip the approval gate, so groups would never be consulted';
  }
  return null;
}

router.post('/', requireRole('admin'), (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  // Extra structural validation (zod handles per-field but cross-field, e.g. duplicate keys, lives here).
  const schemaErr = validateFieldSchema(parse.data.fields);
  if (schemaErr) return res.status(400).json({ error: schemaErr });

  if (db.prepare('SELECT id FROM change_types WHERE key = ?').get(parse.data.key)) {
    return res.status(409).json({ error: 'key already exists' });
  }
  const conflict = rejectAutoApproveWithGroups(parse.data.autoApprove, parse.data.approverGroupIds);
  if (conflict) return res.status(400).json({ error: conflict });
  if (parse.data.approverGroupIds?.length) {
    const found = db.prepare(`SELECT id FROM groups WHERE id IN (${parse.data.approverGroupIds.map(() => '?').join(',')})`)
      .all(...parse.data.approverGroupIds);
    if (found.length !== parse.data.approverGroupIds.length) {
      return res.status(400).json({ error: 'one or more approverGroupIds do not exist' });
    }
  }
  const created = createChangeType(parse.data);
  res.status(201).json({ type: created });
});

const patchSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  fields: z.array(fieldSchema).optional(),
  active: z.boolean().optional(),
  approverGroupIds: z.array(z.number().int().positive()).optional(),
  autoApprove: z.boolean().optional(),
  approvalSlaMinutes: z.number().int().positive().max(60 * 24 * 30).nullable().optional(),
}).strict();

router.patch('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = getChangeTypeById(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const parse = patchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  if (parse.data.fields) {
    const err = validateFieldSchema(parse.data.fields);
    if (err) return res.status(400).json({ error: err });
  }
  if (parse.data.key && parse.data.key !== existing.key) {
    if (db.prepare('SELECT id FROM change_types WHERE key = ? AND id <> ?').get(parse.data.key, id)) {
      return res.status(409).json({ error: 'key already exists' });
    }
  }
  // Effective post-patch values for the conflict check.
  const effectiveAuto = 'autoApprove' in parse.data ? parse.data.autoApprove : existing.autoApprove;
  const effectiveGroups = 'approverGroupIds' in parse.data
    ? parse.data.approverGroupIds
    : existing.approverGroups.map(g => g.id);
  const conflict = rejectAutoApproveWithGroups(effectiveAuto, effectiveGroups);
  if (conflict) return res.status(400).json({ error: conflict });
  if (parse.data.approverGroupIds?.length) {
    const found = db.prepare(`SELECT id FROM groups WHERE id IN (${parse.data.approverGroupIds.map(() => '?').join(',')})`)
      .all(...parse.data.approverGroupIds);
    if (found.length !== parse.data.approverGroupIds.length) {
      return res.status(400).json({ error: 'one or more approverGroupIds do not exist' });
    }
  }
  const updated = updateChangeType(id, parse.data);
  res.json({ type: updated });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = getChangeTypeById(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // Refuse hard-delete if any change refers to this key — soft-delete instead.
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM changes WHERE type_key = ?').get(existing.key).c;
  if (inUse > 0) {
    softDeleteChangeType(id);
    return res.json({ ok: true, soft: true, reason: 'change records reference this type; deactivated instead of deleted' });
  }
  db.prepare('DELETE FROM change_types WHERE id = ?').run(id);
  res.json({ ok: true, soft: false });
});

export default router;
