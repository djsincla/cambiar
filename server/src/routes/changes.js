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
import {
  setRecurrence, clearRecurrence, getRecurringParent, listRecurringParents,
  listChildren, spawnChildFromParent, validateRecurrenceInput,
} from '../services/recurringChanges.js';
import { registerRecurringChange, unregisterRecurringChange } from '../services/recurringScheduler.js';
import {
  addLink, removeLink, getLink, getLinksForChange, getBlockingDeps, LINK_KINDS,
} from '../services/changeLinks.js';
import { purgeFilesForAttachments, tryRemoveEmptyChangeDir } from '../services/attachmentFiles.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired);

const createSchema = z.object({
  typeKey: z.string().min(1).optional(),
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).optional().nullable(),
  fields: z.record(z.any()).optional(),
  scheduledAt: z.string().datetime().optional().nullable(),
  plannedDurationMinutes: z.number().int().positive().max(60 * 24 * 30).optional().nullable(),
  // Either copy fields from another change, or instantiate from a template.
  // Body fields override the source where supplied.
  copyFromChangeId: z.number().int().positive().optional(),
  templateId: z.number().int().positive().optional(),
});

router.get('/', (req, res) => {
  // Inbox view: changes awaiting THIS user's approval, oldest first.
  if (req.query.awaitingMyApproval === 'true') {
    const rows = awaitingApprovalChanges(req.user);
    annotateChangesForViewer(rows, req.user);
    return res.json({ changes: rows.map(formatChange) });
  }

  // Recurring-parents-only view ("/recurring" page).
  if (req.query.recurring === 'parents') {
    return res.json({ recurringParents: listRecurringParents() });
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
  // Recurring parents are generators, not normal changes — exclude unless
  // explicitly asked. (?includeRecurringParents=true to opt in.)
  if (req.query.includeRecurringParents !== 'true') {
    wheres.push('c.is_recurring_parent = 0');
  }
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

  // Resolve seed values from a source (template or another change), then
  // overlay any explicit body fields on top.
  let seed = null;
  let auditDetails = null;
  if (parse.data.copyFromChangeId) {
    const src = db.prepare('SELECT type_key, title, description, fields_json, planned_duration_minutes FROM changes WHERE id = ?').get(parse.data.copyFromChangeId);
    if (!src) return res.status(400).json({ error: `copyFromChangeId ${parse.data.copyFromChangeId} does not exist` });
    seed = {
      typeKey: src.type_key,
      title: `Copy of ${src.title}`,
      description: src.description,
      fields: src.fields_json ? JSON.parse(src.fields_json) : {},
      plannedDurationMinutes: src.planned_duration_minutes,
    };
    auditDetails = { copiedFromChangeId: parse.data.copyFromChangeId };
  }
  if (parse.data.templateId) {
    const t = db.prepare('SELECT type_key, title, body_description, fields_json, planned_duration_minutes FROM change_templates WHERE id = ?').get(parse.data.templateId);
    if (!t) return res.status(400).json({ error: `templateId ${parse.data.templateId} does not exist` });
    seed = {
      typeKey: t.type_key,
      title: t.title,
      description: t.body_description,
      fields: t.fields_json ? JSON.parse(t.fields_json) : {},
      plannedDurationMinutes: t.planned_duration_minutes,
    };
    auditDetails = { fromTemplateId: parse.data.templateId };
  }

  // Body fields override seed values when supplied.
  const typeKey = parse.data.typeKey ?? seed?.typeKey;
  const title = parse.data.title ?? seed?.title;
  const description = 'description' in parse.data ? parse.data.description : seed?.description;
  const fields = parse.data.fields ?? seed?.fields ?? {};
  const plannedDurationMinutes = 'plannedDurationMinutes' in parse.data
    ? parse.data.plannedDurationMinutes
    : seed?.plannedDurationMinutes;

  if (!typeKey || !title) {
    return res.status(400).json({ error: 'typeKey and title are required (either in the body or via templateId/copyFromChangeId)' });
  }

  const info = db.prepare(`
    INSERT INTO changes (type_key, title, description, fields_json, status, submitter_id, scheduled_at, planned_duration_minutes)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(
    typeKey,
    title,
    description ?? null,
    JSON.stringify(fields),
    req.user.id,
    parse.data.scheduledAt ?? null,
    plannedDurationMinutes ?? null,
  );

  recordAudit({
    changeId: info.lastInsertRowid, userId: req.user.id,
    action: 'create', toStatus: 'draft',
    details: auditDetails,
  });
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

  // Recurrence relationships — parent (if this is a child) and recent
  // children (if this is a parent).
  const rawForRecurrence = db.prepare(
    'SELECT parent_change_id, is_recurring_parent, recurrence_cron, recurrence_timezone, recurrence_lead_minutes, recurrence_auto_submit, recurrence_enabled, recurrence_last_fired_at FROM changes WHERE id = ?'
  ).get(change.id);
  let parentRef = null;
  if (rawForRecurrence?.parent_change_id) {
    const p = db.prepare('SELECT id, title FROM changes WHERE id = ?').get(rawForRecurrence.parent_change_id);
    if (p) parentRef = { id: p.id, title: p.title };
  }
  const recurringParent = rawForRecurrence?.is_recurring_parent ? {
    cronExpression: rawForRecurrence.recurrence_cron,
    timezone: rawForRecurrence.recurrence_timezone,
    leadMinutes: rawForRecurrence.recurrence_lead_minutes,
    autoSubmit: Boolean(rawForRecurrence.recurrence_auto_submit),
    enabled: Boolean(rawForRecurrence.recurrence_enabled),
    lastFiredAt: rawForRecurrence.recurrence_last_fired_at,
    recentChildren: listChildren(change.id, { limit: 10 }),
  } : null;

  res.json({
    change,
    approvals,
    audit: loadAudit(change.id),
    requiredApprovalGroups,
    changeType: changeType ? { id: changeType.id, key: changeType.key, name: changeType.name, autoApprove: changeType.autoApprove } : null,
    parent: parentRef,
    recurring: recurringParent,
    links: getLinksForChange(change.id),
  });
});

const patchSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).nullable().optional(),
  fields: z.record(z.any()).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  plannedDurationMinutes: z.number().int().positive().max(60 * 24 * 30).nullable().optional(),
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
  if ('title' in parse.data)                  { sets.push('title = ?'); params.push(parse.data.title); }
  if ('description' in parse.data)            { sets.push('description = ?'); params.push(parse.data.description); }
  if ('fields' in parse.data)                 { sets.push('fields_json = ?'); params.push(JSON.stringify(parse.data.fields ?? {})); }
  if ('scheduledAt' in parse.data)            { sets.push('scheduled_at = ?'); params.push(parse.data.scheduledAt); }
  if ('plannedDurationMinutes' in parse.data) { sets.push('planned_duration_minutes = ?'); params.push(parse.data.plannedDurationMinutes); }
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
  // Reclaim disk space for any uploaded attachments before the cascade
  // removes the DB rows, then drop the per-change uploads dir if empty.
  purgeFilesForAttachments('change_id = ?', [id]);
  db.prepare('DELETE FROM changes WHERE id = ?').run(id);
  tryRemoveEmptyChangeDir(id);
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

const implementSchema = z.object({
  actualDurationMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
}).strict();

// Start the implementation window: approved → in_progress. Optional way to
// reflect "we're hands-on right now" so the calendar / inbox / lists can
// highlight in-flight work distinctly from "approved, scheduled for later".
// Skipping this step is fine — implement still accepts the approved state.
router.post('/:id/start', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.status !== 'approved') return res.status(409).json({ error: 'only approved changes can be started' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only submitter or admin can start implementation' });
  }
  const blocking = getBlockingDeps(id);
  if (blocking.length > 0) {
    return res.status(409).json({
      error: 'blocked by unfinished prerequisite change(s)',
      blockedBy: blocking,
    });
  }
  db.prepare(`UPDATE changes SET status = 'in_progress', in_progress_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  recordAudit({ changeId: id, userId: req.user.id, action: 'start', fromStatus: 'approved', toStatus: 'in_progress' });
  res.json({ change: getChange(id) });
});

router.post('/:id/implement', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  // Both 'approved' (skipped /start) and 'in_progress' (started, now finishing) are valid predecessors.
  if (!['approved', 'in_progress'].includes(change.status)) {
    return res.status(409).json({ error: 'change must be approved or in progress first' });
  }
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only submitter or admin can mark implemented' });
  }
  // Same dep gate as /start — we want callers who skip /start to hit it here.
  // If we're already in_progress the deps were checked at start time; re-check
  // anyway in case a prereq was rolled back in the meantime.
  const blocking = getBlockingDeps(id);
  if (blocking.length > 0) {
    return res.status(409).json({
      error: 'blocked by unfinished prerequisite change(s)',
      blockedBy: blocking,
    });
  }
  const parse = implementSchema.safeParse(req.body ?? {});
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  // If the operator didn't supply an actual duration but we recorded
  // in_progress_at, derive it from elapsed wall-clock time. SQLite's
  // datetime('now') returns "YYYY-MM-DD HH:MM:SS" UTC — normalize to
  // ISO-8601 before parsing.
  const explicit = parse.data.actualDurationMinutes;
  let actual = explicit;
  let derived = false;
  if (explicit == null && change.in_progress_at) {
    const iso = change.in_progress_at.replace(' ', 'T') + 'Z';
    const startedMs = Date.parse(iso);
    if (Number.isFinite(startedMs)) {
      const elapsed = Math.max(1, Math.round((Date.now() - startedMs) / 60_000));
      actual = elapsed;
      derived = true;
    }
  }

  const fromStatus = change.status;
  if (actual != null) {
    db.prepare(`UPDATE changes SET status = 'implemented', implemented_at = datetime('now'), actual_duration_minutes = ?, updated_at = datetime('now') WHERE id = ?`).run(actual, id);
  } else {
    db.prepare(`UPDATE changes SET status = 'implemented', implemented_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  }
  recordAudit({
    changeId: id, userId: req.user.id, action: 'implement',
    fromStatus, toStatus: 'implemented',
    details: actual != null
      ? (derived ? { actualDurationMinutes: actual, derivedFromInProgressAt: true } : { actualDurationMinutes: actual })
      : null,
  });
  await notify('implemented', { change: dbRow(id), actor: req.user });
  res.json({ change: getChange(id) });
});

const actualDurationSchema = z.object({
  actualDurationMinutes: z.number().int().positive().max(60 * 24 * 30).nullable(),
}).strict();

// Update (or clear) actual duration after the implementation window. Available
// while the change is in 'implemented' or 'closed' (not 'rolled_back', since a
// rolled-back change's "actual duration" stops being meaningful).
router.patch('/:id/actual-duration', async (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (!['implemented', 'closed'].includes(change.status)) {
    return res.status(409).json({ error: 'actual duration can only be set on implemented or closed changes' });
  }
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only submitter or admin can update actual duration' });
  }
  const parse = actualDurationSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const prev = change.actual_duration_minutes;
  db.prepare(`UPDATE changes SET actual_duration_minutes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(parse.data.actualDurationMinutes, id);
  recordAudit({
    changeId: id, userId: req.user.id, action: 'set_actual_duration',
    details: { from: prev, to: parse.data.actualDurationMinutes },
  });
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
  if (!['in_progress', 'implemented', 'closed'].includes(change.status)) {
    return res.status(409).json({ error: 'only in-progress, implemented, or closed changes can be rolled back' });
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
    plannedDurationMinutes: r.planned_duration_minutes,
    actualDurationMinutes: r.actual_duration_minutes,
    submittedAt: r.submitted_at,
    inProgressAt: r.in_progress_at,
    implementedAt: r.implemented_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    viewerIsSubmitter: Boolean(r.viewerIsSubmitter),
    viewerCanApprove: Boolean(r.viewerCanApprove),
  };
}

// --- Change links (depends_on / relates_to) ---

const linkSchema = z.object({
  toChangeId: z.number().int().positive(),
  kind: z.enum(LINK_KINDS),
});

router.post('/:id/links', (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT submitter_id FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the submitter or an admin can link this change' });
  }
  const parse = linkSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  try {
    const { id: linkId } = addLink({
      fromChangeId: id,
      toChangeId: parse.data.toChangeId,
      kind: parse.data.kind,
      userId: req.user.id,
    });
    recordAudit({
      changeId: id, userId: req.user.id, action: 'add_link',
      details: { toChangeId: parse.data.toChangeId, kind: parse.data.kind, linkId },
    });
    res.status(201).json({ links: getLinksForChange(id) });
  } catch (err) {
    if (err.code === 'self_link' || err.code === 'cycle' || err.code === 'duplicate' || err.code === 'invalid_kind') {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === 'not_found') {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

router.delete('/:id/links/:linkId', (req, res) => {
  const id = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  const change = db.prepare('SELECT submitter_id FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the submitter or an admin can remove a link' });
  }
  // Verify the link actually touches this change (so /api/changes/A/links/X
  // can't delete a link belonging to change B).
  const link = getLink(linkId);
  if (!link || (link.from_change_id !== id && link.to_change_id !== id)) {
    return res.status(404).json({ error: 'link not found' });
  }
  removeLink(linkId);
  recordAudit({
    changeId: id, userId: req.user.id, action: 'remove_link',
    details: { linkId, kind: link.kind, otherChangeId: link.from_change_id === id ? link.to_change_id : link.from_change_id },
  });
  res.json({ links: getLinksForChange(id) });
});

// --- Recurring changes (parent → child) ---

const recurrenceSchema = z.object({
  cronExpression: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).default('UTC'),
  leadMinutes: z.number().int().min(0).max(525600).default(0),
  autoSubmit: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

router.post('/:id/recurrence', (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the submitter or an admin can configure recurrence' });
  }
  const parse = recurrenceSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const err = validateRecurrenceInput(parse.data);
  if (err) return res.status(400).json({ error: err });

  const updated = setRecurrence(id, parse.data);
  recordAudit({
    changeId: id, userId: req.user.id, action: 'set_recurrence',
    details: parse.data,
  });
  registerRecurringChange(updated);
  res.json({ recurring: {
    cronExpression: updated.recurrenceCron,
    timezone: updated.recurrenceTimezone,
    leadMinutes: updated.recurrenceLeadMinutes,
    autoSubmit: updated.recurrenceAutoSubmit,
    enabled: updated.recurrenceEnabled,
    lastFiredAt: updated.recurrenceLastFiredAt,
  }});
});

router.delete('/:id/recurrence', (req, res) => {
  const id = Number(req.params.id);
  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!change) return res.status(404).json({ error: 'not found' });
  if (change.submitter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the submitter or an admin can clear recurrence' });
  }
  unregisterRecurringChange(id);
  clearRecurrence(id);
  recordAudit({ changeId: id, userId: req.user.id, action: 'clear_recurrence' });
  res.json({ ok: true });
});

router.post('/:id/spawn-now', async (req, res) => {
  const id = Number(req.params.id);
  const parent = getRecurringParent(id);
  if (!parent) return res.status(404).json({ error: 'not a recurring parent' });
  if (parent.submitterId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'only the submitter or an admin can spawn manually' });
  }
  try {
    const result = await spawnChildFromParent(parent);
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, parentId: id }, 'manual spawn failed');
    res.status(500).json({ error: err.message });
  }
});

export default router;
