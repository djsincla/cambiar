import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { requireAuth, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

const router = Router({ mergeParams: true });
router.use(requireAuth, blockIfPasswordChangeRequired);

function loadChange(req, res) {
  const id = Number(req.params.changeId);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid change id' }); return null; }
  const change = db.prepare('SELECT id, submitter_id FROM changes WHERE id = ?').get(id);
  if (!change) { res.status(404).json({ error: 'change not found' }); return null; }
  return change;
}

function formatNote(r) {
  return {
    id: r.id,
    changeId: r.change_id,
    body: r.body,
    author: r.user_id ? {
      id: r.user_id,
      username: r.author_username,
      displayName: r.author_display_name,
    } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get('/', (req, res) => {
  const change = loadChange(req, res);
  if (!change) return;
  const rows = db.prepare(`
    SELECT n.*, u.username AS author_username, u.display_name AS author_display_name
    FROM change_notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.change_id = ?
    ORDER BY n.id ASC
  `).all(change.id);
  res.json({ notes: rows.map(formatNote) });
});

const noteBody = z.object({ body: z.string().min(1).max(50_000) });

router.post('/', (req, res) => {
  const change = loadChange(req, res);
  if (!change) return;
  const parse = noteBody.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const info = db.prepare(`
    INSERT INTO change_notes (change_id, user_id, body) VALUES (?, ?, ?)
  `).run(change.id, req.user.id, parse.data.body);
  recordAudit({ changeId: change.id, userId: req.user.id, action: 'note_add', details: { noteId: Number(info.lastInsertRowid) } });

  const row = db.prepare(`
    SELECT n.*, u.username AS author_username, u.display_name AS author_display_name
    FROM change_notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json({ note: formatNote(row) });
});

router.patch('/:noteId', (req, res) => {
  const change = loadChange(req, res);
  if (!change) return;
  const noteId = Number(req.params.noteId);
  const note = db.prepare('SELECT * FROM change_notes WHERE id = ? AND change_id = ?').get(noteId, change.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  if (note.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the author or an admin can edit this note' });
  }
  const parse = noteBody.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  db.prepare(`UPDATE change_notes SET body = ?, updated_at = datetime('now') WHERE id = ?`).run(parse.data.body, noteId);
  const row = db.prepare(`
    SELECT n.*, u.username AS author_username, u.display_name AS author_display_name
    FROM change_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = ?
  `).get(noteId);
  res.json({ note: formatNote(row) });
});

router.delete('/:noteId', (req, res) => {
  const change = loadChange(req, res);
  if (!change) return;
  const noteId = Number(req.params.noteId);
  const note = db.prepare('SELECT * FROM change_notes WHERE id = ? AND change_id = ?').get(noteId, change.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  if (note.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the author or an admin can delete this note' });
  }
  db.prepare('DELETE FROM change_notes WHERE id = ?').run(noteId);
  recordAudit({ changeId: change.id, userId: req.user.id, action: 'note_delete', details: { noteId } });
  res.json({ ok: true });
});

export default router;
