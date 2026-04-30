import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { requireAuth, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { getChangeTypeByKey } from '../services/changeTypes.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired);

function rowToTemplate(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    typeKey: r.type_key,
    title: r.title,
    bodyDescription: r.body_description,
    fields: r.fields_json ? JSON.parse(r.fields_json) : {},
    plannedDurationMinutes: r.planned_duration_minutes,
    createdBy: r.created_by_id ? {
      id: r.created_by_id,
      username: r.creator_username,
      displayName: r.creator_display_name,
    } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.username AS creator_username, u.display_name AS creator_display_name
    FROM change_templates t LEFT JOIN users u ON u.id = t.created_by_id
    ORDER BY t.name
  `).all();
  res.json({ templates: rows.map(rowToTemplate) });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare(`
    SELECT t.*, u.username AS creator_username, u.display_name AS creator_display_name
    FROM change_templates t LEFT JOIN users u ON u.id = t.created_by_id
    WHERE t.id = ?
  `).get(id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ template: rowToTemplate(r) });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  typeKey: z.string().min(1),
  title: z.string().min(1).max(255),
  bodyDescription: z.string().max(10_000).nullable().optional(),
  fields: z.record(z.any()).optional(),
  plannedDurationMinutes: z.number().int().positive().max(60 * 24 * 30).nullable().optional(),
  fromChangeId: z.number().int().positive().optional(),
});

router.post('/', (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  // If fromChangeId is supplied, the client wants "save this change as template".
  // Server-side we still trust the body's name/description/typeKey/etc., but
  // we'll only allow the from-change reference for users who can see that change.
  // (All authed users can see all changes today; this gate is forward-looking.)
  if (parse.data.fromChangeId) {
    const exists = db.prepare('SELECT 1 FROM changes WHERE id = ?').get(parse.data.fromChangeId);
    if (!exists) return res.status(400).json({ error: `fromChangeId ${parse.data.fromChangeId} does not exist` });
  }

  if (!getChangeTypeByKey(parse.data.typeKey, { activeOnly: false })) {
    return res.status(400).json({ error: `unknown change type: ${parse.data.typeKey}` });
  }
  if (db.prepare('SELECT id FROM change_templates WHERE name = ?').get(parse.data.name)) {
    return res.status(409).json({ error: 'template name already exists' });
  }

  const info = db.prepare(`
    INSERT INTO change_templates
      (name, description, type_key, title, body_description, fields_json, planned_duration_minutes, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parse.data.name,
    parse.data.description ?? null,
    parse.data.typeKey,
    parse.data.title,
    parse.data.bodyDescription ?? null,
    JSON.stringify(parse.data.fields ?? {}),
    parse.data.plannedDurationMinutes ?? null,
    req.user.id,
  );

  const row = db.prepare(`
    SELECT t.*, u.username AS creator_username, u.display_name AS creator_display_name
    FROM change_templates t LEFT JOIN users u ON u.id = t.created_by_id WHERE t.id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json({ template: rowToTemplate(row) });
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  typeKey: z.string().min(1).optional(),
  title: z.string().min(1).max(255).optional(),
  bodyDescription: z.string().max(10_000).nullable().optional(),
  fields: z.record(z.any()).optional(),
  plannedDurationMinutes: z.number().int().positive().max(60 * 24 * 30).nullable().optional(),
}).strict();

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM change_templates WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.created_by_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the creator or an admin can edit this template' });
  }

  const parse = patchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  if (parse.data.typeKey && !getChangeTypeByKey(parse.data.typeKey, { activeOnly: false })) {
    return res.status(400).json({ error: `unknown change type: ${parse.data.typeKey}` });
  }
  if (parse.data.name && parse.data.name !== existing.name) {
    if (db.prepare('SELECT id FROM change_templates WHERE name = ? AND id <> ?').get(parse.data.name, id)) {
      return res.status(409).json({ error: 'template name already exists' });
    }
  }

  const sets = [];
  const params = [];
  for (const [k, col] of [['name','name'], ['description','description'], ['typeKey','type_key'],
                          ['title','title'], ['bodyDescription','body_description'],
                          ['plannedDurationMinutes','planned_duration_minutes']]) {
    if (k in parse.data) { sets.push(`${col} = ?`); params.push(parse.data[k]); }
  }
  if ('fields' in parse.data) { sets.push('fields_json = ?'); params.push(JSON.stringify(parse.data.fields ?? {})); }

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE change_templates SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  const row = db.prepare(`
    SELECT t.*, u.username AS creator_username, u.display_name AS creator_display_name
    FROM change_templates t LEFT JOIN users u ON u.id = t.created_by_id WHERE t.id = ?
  `).get(id);
  res.json({ template: rowToTemplate(row) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM change_templates WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.created_by_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the creator or an admin can delete this template' });
  }
  db.prepare('DELETE FROM change_templates WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
