import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { requireAuth, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { unlinkAttachmentFile } from '../services/attachmentFiles.js';

const router = Router({ mergeParams: true });
router.use(requireAuth, blockIfPasswordChangeRequired);

const UPLOAD_ROOT = resolve(config.dataDir, 'uploads', 'changes');
mkdirSync(UPLOAD_ROOT, { recursive: true });

// Allowed MIME types and the canonical on-disk extension for each. SVG is
// deliberately excluded — SVG natively supports <script> and event handlers,
// which would execute in the cambiar origin when an attachment is opened
// directly via /uploads/changes/N/att-xxx.svg.
const ALLOWED = new Map([
  ['image/png',     '.png'],
  ['image/jpeg',    '.jpg'],
  ['image/webp',    '.webp'],
  ['image/gif',     '.gif'],
  ['application/pdf', '.pdf'],
  ['text/plain',    '.txt'],
  ['text/csv',      '.csv'],
  ['application/json', '.json'],
]);
const MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = resolve(UPLOAD_ROOT, String(Number(req.params.changeId)));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      // Derive extension from the validated mimetype, NOT the original
      // filename. The previous order let an attacker upload "evil.html" with
      // a multipart Content-Type of image/png — fileFilter passed (mimetype
      // is allowed) but the file landed on disk as att-xxx.html and was
      // served by express.static as text/html, executing the embedded JS in
      // cambiar's origin with the victim's session cookie.
      const ext = ALLOWED.get(file.mimetype) ?? '';
      cb(null, `att-${randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error(`disallowed file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

function loadChange(req, res) {
  const id = Number(req.params.changeId);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid change id' }); return null; }
  const change = db.prepare('SELECT id, submitter_id FROM changes WHERE id = ?').get(id);
  if (!change) { res.status(404).json({ error: 'change not found' }); return null; }
  return change;
}

function formatAttachment(r) {
  return {
    id: r.id,
    changeId: r.change_id,
    noteId: r.note_id ?? null,
    filename: r.filename,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    url: `/uploads/changes/${r.change_id}/${r.filename}`,
    uploader: r.user_id ? { id: r.user_id, username: r.author_username, displayName: r.author_display_name } : null,
    createdAt: r.created_at,
  };
}

// scope=change-wide : only attachments with note_id IS NULL
// scope=note&noteId=N : only attachments belonging to that note
// (default) : all attachments for the change
router.get('/', (req, res) => {
  const change = loadChange(req, res);
  if (!change) return;
  const scope = String(req.query.scope ?? '');
  const noteId = req.query.noteId ? Number(req.query.noteId) : null;

  let where = 'a.change_id = ?';
  const params = [change.id];
  if (scope === 'change-wide') {
    where += ' AND a.note_id IS NULL';
  } else if (scope === 'note' && Number.isFinite(noteId)) {
    where += ' AND a.note_id = ?';
    params.push(noteId);
  }
  const rows = db.prepare(`
    SELECT a.*, u.username AS author_username, u.display_name AS author_display_name
    FROM change_attachments a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where} ORDER BY a.id ASC
  `).all(...params);
  res.json({ attachments: rows.map(formatAttachment) });
});

router.post('/', (req, res) => {
  const change = loadChange(req, res);
  if (!change) return;

  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

    // Multer parses non-file form fields into req.body. Optional noteId
    // threads the upload under a specific note; we validate it belongs
    // to this change so a hostile client can't cross-link.
    let noteId = null;
    if (req.body.noteId != null && req.body.noteId !== '') {
      const n = Number(req.body.noteId);
      if (!Number.isFinite(n)) return res.status(400).json({ error: 'invalid noteId' });
      const note = db.prepare('SELECT id FROM change_notes WHERE id = ? AND change_id = ?').get(n, change.id);
      if (!note) return res.status(400).json({ error: 'note does not belong to this change' });
      noteId = n;
    }

    const info = db.prepare(`
      INSERT INTO change_attachments (change_id, user_id, note_id, filename, original_filename, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(change.id, req.user.id, noteId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
    recordAudit({
      changeId: change.id, userId: req.user.id, action: 'attachment_add',
      details: { attachmentId: Number(info.lastInsertRowid), filename: req.file.originalname, noteId },
    });

    const row = db.prepare(`
      SELECT a.*, u.username AS author_username, u.display_name AS author_display_name
      FROM change_attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?
    `).get(info.lastInsertRowid);
    res.status(201).json({ attachment: formatAttachment(row) });
  });
});

router.delete('/:attachmentId', (req, res) => {
  const change = loadChange(req, res);
  if (!change) return;
  const attId = Number(req.params.attachmentId);
  const att = db.prepare('SELECT * FROM change_attachments WHERE id = ? AND change_id = ?').get(attId, change.id);
  if (!att) return res.status(404).json({ error: 'attachment not found' });
  if (att.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the uploader or an admin can delete this attachment' });
  }

  unlinkAttachmentFile(attId);
  db.prepare('DELETE FROM change_attachments WHERE id = ?').run(attId);
  recordAudit({ changeId: change.id, userId: req.user.id, action: 'attachment_delete', details: { attachmentId: attId } });
  res.json({ ok: true });
});

export default router;
