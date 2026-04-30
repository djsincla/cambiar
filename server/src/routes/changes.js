import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { validateFields, getChangeTypeByKey } from '../services/changeTypes.js';
import { userCanApprove, awaitingApprovalChanges } from '../services/groups.js';
import { annotateChangesForViewer } from '../services/changes.js';
import { recordAudit, loadAudit } from '../services/audit.js';
import { notify } from '../notifications/index.js';
import { logger } from '../logger.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired);

const createSchema = z.object({
  typeKey: z.string().min(1),
  title: z.string().min(1).max(255),
  description: z.string().max(10_000).optional().nullable(),
  fields: z.record(z.any()).optional(),
  scheduledAt: z.string().datetime().optional().nullable(),
});

router.get('/', (req, res) => {
  // Inbox view: changes awaiting THIS user's approval, oldest first.
  if (req.query.awaitingMyApproval === 'true') {
    const rows = awaitingApprovalChanges(req.user);
    annotateChangesForViewer(rows, req.user);
    return res.json({ changes: rows.map(formatChange) });
  }

  const { status, mine, type, scheduledFrom, scheduledTo } = req.query;
  const wheres = [];
  const params = [];
  if (status) {
    // Allow CSV: ?status=approved,implemented
    const list = String(status).split(',').filter(Boolean);
    if (list.length === 1) { wheres.push('c.status = ?'); params.push(list[0]); }
    else if (list.length > 1) {
      wheres.push(`c.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (type)   { wheres.push('c.type_key = ?'); params.push(String(type)); }
  if (mine === 'true') { wheres.push('c.submitter_id = ?'); params.push(req.user.id); }
  // Date range filters for the upcoming view (calendar / list).
  if (scheduledFrom) { wheres.push('c.scheduled_at >= ?'); params.push(String(scheduledFrom)); }
  if (scheduledTo)   { wheres.push('c.scheduled_at <= ?'); params.push(String(scheduledTo)); }
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

  // When a date range is supplied, sort by scheduled_at ASC (queue order).
  const orderBy = (scheduledFrom || scheduledTo) ? 'c.scheduled_at ASC, c.id ASC' : 'c.id DESC';

  const rows = db.prepare(`
    SELECT c.*, u.username AS submitter_username, u.display_name AS submitter_display_name
    FROM changes c JOIN users u ON u.id = c.submitter_id
    ${where}
    ORDER BY ${orderBy}
    LIMIT 500
  `).all(...params);
  annotateChangesForViewer(rows, req.user);
  res.json({ changes: rows.map(formatChange) });
});

router.post('/', (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const validated = validateFields(parse.data.typeKey, parse.data.fields ?? {});
  // For drafts we *allow* incomplete fields, but type/select values still must be valid.
  // We re-validate strictly on submit.
  const fieldsToStore = parse.data.fields ?? {};

  const info = db.prepare(`
    INSERT INTO changes (type_key, title, description, fields_json, status, submitter_id, scheduled_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?)
  `).run(
    parse.data.typeKey,
    parse.data.title,
    parse.data.description ?? null,
    JSON.stringify(fieldsToStore),
    req.user.id,
    parse.data.scheduledAt ?? null,
  );

  recordAudit({ changeId: info.lastInsertRowid, userId: req.user.id, action: 'create', toStatus: 'draft' });
  res.status(201).json({ change: getChange(info.lastInsertRowid) });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const raw = db.prepare(`
    SELECT c.*, u.username AS submitter_username, u.display_name AS submitter_display_name
    FROM changes c JOIN users u ON u.id = c.submitter_id WHERE c.id = ?
  `).get(id);
  if (!raw) return res.status(404).json({ error: 'not found' });
  annotateChangesForViewer([raw], req.user);
  const change = formatChange(raw);
  const approvals = db.prepare(`
    SELECT a.*, u.username, u.display_name FROM approvals a JOIN users u ON u.id = a.approver_id
    WHERE a.change_id = ? ORDER BY a.id ASC
  `).all(change.id).map(a => ({
    id: a.id,
    decision: a.decision,
    comment: a.comment,
    decidedAt: a.decided_at,
    approver: { id: a.approver_id, username: a.username, displayName: a.display_name },
  }));
  // Surface the approval policy for this change's type so the UI can render
  // "any one of these groups must approve" or "auto-approved".
  const changeType = getChangeTypeByKey(change.typeKey, { activeOnly: false });
  const requiredApprovalGroups = changeType?.approverGroups ?? [];
  res.json({
    change,
    approvals,
    audit: loadAudit(change.id),
    requiredApprovalGroups,
    changeType: changeType ? { id: changeType.id, key: changeType.key, name: changeType.name, autoApprove: changeType.autoApprove } : null,
  });
});

const patchSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).nullable().optional(),
  fields: z.record(z.any()).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
}).strict();

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status !== 'draft') return res.status(409).json({ error: 'only drafts can be edited' });
  if (existing.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not your change' });
  }

  const parse = patchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const sets = [];
  const params = [];
  if ('title' in parse.data)        { sets.push('title = ?'); params.push(parse.data.title); }
  if ('description' in parse.data)  { sets.push('description = ?'); params.push(parse.data.description); }
  if ('fields' in parse.data)       { sets.push('fields_json = ?'); params.push(JSON.stringify(parse.data.fields ?? {})); }
  if ('scheduledAt' in parse.data)  { sets.push('scheduled_at = ?'); params.push(parse.data.scheduledAt); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });

  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE changes SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  recordAudit({ changeId: id, userId: req.user.id, action: 'update' });
  res.json({ change: getChange(id) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status !== 'draft') return res.status(409).json({ error: 'only drafts can be deleted' });
  if (existing.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not your change' });
  }
  db.prepare('DELETE FROM changes WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.post('/:id/submit', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.status !== 'draft') return res.status(409).json({ error: 'only drafts can be submitted' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'not your change' });
  }

  const v = validateFields(change.type_key, JSON.parse(change.fields_json));
  if (!v.ok) return res.status(400).json({ error: v.error });

  // Look up the type once to decide whether this is a standard (auto-approved)
  // change. Field validation already ran against the same source.
  const changeType = getChangeTypeByKey(change.type_key, { activeOnly: false });
  const isAutoApprove = Boolean(changeType?.autoApprove);

  if (isAutoApprove) {
    // draft → submitted → approved, all in one transaction. Two audit rows
    // make the policy decision visible to auditors.
    const tx = db.transaction(() => {
      db.prepare(`UPDATE changes SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'draft'`).run(id);
      recordAudit({ changeId: id, userId: req.user.id, action: 'submit', fromStatus: 'draft', toStatus: 'submitted' });
      db.prepare(`UPDATE changes SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND status = 'submitted'`).run(id);
      recordAudit({
        changeId: id, userId: null /* system */, action: 'auto_approve',
        fromStatus: 'submitted', toStatus: 'approved',
        details: { reason: 'change type configured for auto-approval' },
      });
    });
    tx();
    // Skip the 'submitted' notification (no one needs to act). Tell the
    // submitter their change cleared.
    await notify('approved', { change: dbRow(id), actor: req.user });
    return res.json({ change: getChange(id) });
  }

  // Normal flow.
  const txNormal = db.transaction(() => {
    db.prepare(`UPDATE changes SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'draft'`).run(id);
    recordAudit({ changeId: id, userId: req.user.id, action: 'submit', fromStatus: 'draft', toStatus: 'submitted' });
  });
  txNormal();
  await notify('submitted', { change: dbRow(id), actor: req.user });
  res.json({ change: getChange(id) });
});

const decisionSchema = z.object({ comment: z.string().max(2000).optional() });

router.post('/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.status !== 'submitted') return res.status(409).json({ error: 'change is not awaiting approval' });

  const changeType = getChangeTypeByKey(change.type_key, { activeOnly: false });
  const { allowed, reason } = userCanApprove({ user: req.user, change, changeType });
  if (!allowed) return res.status(403).json({ error: reason });

  const { comment } = decisionSchema.parse(req.body ?? {});
  db.prepare(`INSERT INTO approvals (change_id, approver_id, decision, comment) VALUES (?, ?, 'approved', ?)`)
    .run(id, req.user.id, comment ?? null);
  transition(id, 'submitted', 'approved', req.user.id, 'approve', { comment });
  await notify('approved', { change: dbRow(id), actor: req.user });
  res.json({ change: getChange(id) });
});

router.post('/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.status !== 'submitted') return res.status(409).json({ error: 'change is not awaiting approval' });

  const changeType = getChangeTypeByKey(change.type_key, { activeOnly: false });
  const { allowed, reason } = userCanApprove({ user: req.user, change, changeType });
  if (!allowed) return res.status(403).json({ error: reason });

  const { comment } = decisionSchema.parse(req.body ?? {});
  db.prepare(`INSERT INTO approvals (change_id, approver_id, decision, comment) VALUES (?, ?, 'rejected', ?)`)
    .run(id, req.user.id, comment ?? null);
  transition(id, 'submitted', 'rejected', req.user.id, 'reject', { comment });
  await notify('rejected', { change: dbRow(id), actor: req.user });
  res.json({ change: getChange(id) });
});

router.post('/:id/implement', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.status !== 'approved') return res.status(409).json({ error: 'change must be approved first' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only submitter or admin can mark implemented' });
  }
  db.prepare(`UPDATE changes SET status = 'implemented', implemented_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  recordAudit({ changeId: id, userId: req.user.id, action: 'implement', fromStatus: 'approved', toStatus: 'implemented' });
  await notify('implemented', { change: dbRow(id), actor: req.user });
  res.json({ change: getChange(id) });
});

router.post('/:id/close', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.status !== 'implemented') return res.status(409).json({ error: 'only implemented changes can be closed' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only submitter or admin can close' });
  }
  db.prepare(`UPDATE changes SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  recordAudit({ changeId: id, userId: req.user.id, action: 'close', fromStatus: 'implemented', toStatus: 'closed' });
  await notify('closed', { change: dbRow(id), actor: req.user });
  res.json({ change: getChange(id) });
});

router.post('/:id/rollback', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (!['implemented', 'closed'].includes(change.status)) {
    return res.status(409).json({ error: 'only implemented or closed changes can be rolled back' });
  }
  const { comment } = decisionSchema.parse(req.body ?? {});
  db.prepare(`UPDATE changes SET status = 'rolled_back', updated_at = datetime('now') WHERE id = ?`).run(id);
  recordAudit({ changeId: id, userId: req.user.id, action: 'rollback', fromStatus: change.status, toStatus: 'rolled_back', details: { comment } });
  res.json({ change: getChange(id) });
});

function transition(id, from, to, userId, action, details) {
  const info = db.prepare(`UPDATE changes SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`).run(to, id, from);
  if (info.changes === 0) {
    throw new Error(`stale transition: ${from}->${to} on change ${id}`);
  }
  recordAudit({ changeId: id, userId, action, fromStatus: from, toStatus: to, details });
}

function dbRow(id) {
  return db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
}

function getChange(id) {
  const row = db.prepare(`
    SELECT c.*, u.username AS submitter_username, u.display_name AS submitter_display_name
    FROM changes c JOIN users u ON u.id = c.submitter_id WHERE c.id = ?
  `).get(id);
  return row ? formatChange(row) : null;
}

function formatChange(r) {
  return {
    id: r.id,
    typeKey: r.type_key,
    title: r.title,
    description: r.description,
    fields: r.fields_json ? JSON.parse(r.fields_json) : {},
    status: r.status,
    submitter: { id: r.submitter_id, username: r.submitter_username, displayName: r.submitter_display_name },
    scheduledAt: r.scheduled_at,
    submittedAt: r.submitted_at,
    implementedAt: r.implemented_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    viewerIsSubmitter: Boolean(r.viewerIsSubmitter),
    viewerCanApprove: Boolean(r.viewerCanApprove),
  };
}

export default router;
