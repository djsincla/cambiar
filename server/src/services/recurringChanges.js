import cron from 'node-cron';
import { db } from '../db/index.js';
import { logger } from '../logger.js';
import { recordAudit } from './audit.js';
import { getChangeTypeByKey, validateFields } from './changeTypes.js';
import { notify } from '../notifications/index.js';

export function isValidCron(expr) {
  return typeof expr === 'string' && cron.validate(expr);
}

function rowToParent(r) {
  if (!r) return null;
  return {
    id: r.id,
    typeKey: r.type_key,
    title: r.title,
    description: r.description,
    fields: r.fields_json ? JSON.parse(r.fields_json) : {},
    plannedDurationMinutes: r.planned_duration_minutes,
    submitterId: r.submitter_id,
    isRecurringParent: Boolean(r.is_recurring_parent),
    recurrenceCron: r.recurrence_cron,
    recurrenceTimezone: r.recurrence_timezone,
    recurrenceLeadMinutes: r.recurrence_lead_minutes,
    recurrenceAutoSubmit: Boolean(r.recurrence_auto_submit),
    recurrenceEnabled: Boolean(r.recurrence_enabled),
    recurrenceLastFiredAt: r.recurrence_last_fired_at,
  };
}

export function getRecurringParent(id) {
  return rowToParent(db.prepare('SELECT * FROM changes WHERE id = ? AND is_recurring_parent = 1').get(id));
}

export function listRecurringParents() {
  const rows = db.prepare(`
    SELECT c.*, u.username AS submitter_username, u.display_name AS submitter_display_name,
           (SELECT COUNT(*) FROM changes ch WHERE ch.parent_change_id = c.id) AS child_count
    FROM changes c JOIN users u ON u.id = c.submitter_id
    WHERE c.is_recurring_parent = 1
    ORDER BY c.id ASC
  `).all();
  return rows.map(r => ({
    id: r.id,
    typeKey: r.type_key,
    title: r.title,
    submitter: { id: r.submitter_id, username: r.submitter_username, displayName: r.submitter_display_name },
    recurrenceCron: r.recurrence_cron,
    recurrenceTimezone: r.recurrence_timezone,
    recurrenceLeadMinutes: r.recurrence_lead_minutes,
    recurrenceAutoSubmit: Boolean(r.recurrence_auto_submit),
    recurrenceEnabled: Boolean(r.recurrence_enabled),
    recurrenceLastFiredAt: r.recurrence_last_fired_at,
    childCount: r.child_count,
  }));
}

export function listEnabledRecurringParents() {
  return db.prepare(`SELECT * FROM changes WHERE is_recurring_parent = 1 AND recurrence_enabled = 1`)
    .all().map(rowToParent);
}

export function listChildren(parentId, { limit = 10 } = {}) {
  return db.prepare(`
    SELECT c.id, c.title, c.status, c.scheduled_at, c.created_at
    FROM changes c WHERE c.parent_change_id = ?
    ORDER BY c.id DESC
    LIMIT ?
  `).all(parentId, limit).map(r => ({
    id: r.id, title: r.title, status: r.status,
    scheduledAt: r.scheduled_at, createdAt: r.created_at,
  }));
}

export function validateRecurrenceInput(input) {
  if (!isValidCron(input.cronExpression)) return 'invalid cron expression';
  if (typeof input.timezone !== 'string' || !input.timezone) return 'timezone is required';
  if ('leadMinutes' in input) {
    if (!Number.isInteger(input.leadMinutes) || input.leadMinutes < 0 || input.leadMinutes > 525600) {
      return 'leadMinutes must be a non-negative integer up to 525600 (one year)';
    }
  }
  return null;
}

/** Mark an existing change as a recurring parent (or update its recurrence config). */
export function setRecurrence(changeId, cfg) {
  db.prepare(`
    UPDATE changes
       SET is_recurring_parent = 1,
           recurrence_cron = ?,
           recurrence_timezone = ?,
           recurrence_lead_minutes = ?,
           recurrence_auto_submit = ?,
           recurrence_enabled = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    cfg.cronExpression,
    cfg.timezone ?? 'UTC',
    cfg.leadMinutes ?? 0,
    cfg.autoSubmit === false ? 0 : 1,
    cfg.enabled === false ? 0 : 1,
    changeId,
  );
  return getRecurringParent(changeId);
}

/** Clear recurrence — the change becomes non-recurring; existing children untouched. */
export function clearRecurrence(changeId) {
  db.prepare(`
    UPDATE changes
       SET is_recurring_parent = 0,
           recurrence_cron = NULL,
           recurrence_timezone = NULL,
           recurrence_lead_minutes = 0,
           recurrence_enabled = 0,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(changeId);
}

/**
 * Spawn a child change from a recurring parent. Copies the parent's blueprint,
 * sets parent_change_id, sets scheduled_at = now + leadMinutes, applies the
 * auto-submit flow if configured, and propagates auto-approve through the
 * change type's flag.
 *
 * Returns { childId, status } describing the resulting state.
 */
export async function spawnChildFromParent(parent, { now = new Date() } = {}) {
  const scheduledMs = now.getTime() + (parent.recurrenceLeadMinutes ?? 0) * 60_000;
  const scheduledIso = new Date(scheduledMs).toISOString();

  let childId;
  const txInsert = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO changes
        (type_key, title, description, fields_json, status, submitter_id,
         scheduled_at, planned_duration_minutes, parent_change_id)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      parent.typeKey,
      parent.title,
      parent.description,
      JSON.stringify(parent.fields ?? {}),
      parent.submitterId,
      scheduledIso,
      parent.plannedDurationMinutes,
      parent.id,
    );
    childId = Number(info.lastInsertRowid);
    recordAudit({
      changeId: childId, userId: null, action: 'create', toStatus: 'draft',
      details: { source: 'recurring', parentChangeId: parent.id, fireTime: now.toISOString() },
    });
    db.prepare(`UPDATE changes SET recurrence_last_fired_at = ? WHERE id = ?`)
      .run(now.toISOString(), parent.id);
  });
  txInsert();

  if (!parent.recurrenceAutoSubmit) {
    return { childId, status: 'draft' };
  }

  // Validate fields strictly before auto-submit; if they fail, leave the child
  // as draft and surface in the audit log so an operator can fix it.
  const child = db.prepare('SELECT * FROM changes WHERE id = ?').get(childId);
  const v = validateFields(child.type_key, JSON.parse(child.fields_json));
  if (!v.ok) {
    recordAudit({
      changeId: childId, userId: null, action: 'auto_submit_blocked',
      details: { source: 'recurring', reason: v.error },
    });
    return { childId, status: 'draft', autoSubmitBlocked: v.error };
  }

  const ct = getChangeTypeByKey(child.type_key, { activeOnly: false });
  const txSubmit = db.transaction(() => {
    db.prepare(`UPDATE changes SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(childId);
    recordAudit({
      changeId: childId, userId: null, action: 'submit',
      fromStatus: 'draft', toStatus: 'submitted',
      details: { source: 'recurring' },
    });
    if (ct?.autoApprove) {
      db.prepare(`UPDATE changes SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(childId);
      recordAudit({
        changeId: childId, userId: null, action: 'auto_approve',
        fromStatus: 'submitted', toStatus: 'approved',
        details: { reason: 'change type configured for auto-approval' },
      });
    }
  });
  txSubmit();

  const finalStatus = ct?.autoApprove ? 'approved' : 'submitted';
  const event = finalStatus === 'approved' ? 'approved' : 'submitted';
  await notify(event, {
    change: db.prepare('SELECT * FROM changes WHERE id = ?').get(childId),
    actor: { id: parent.submitterId, username: 'recurring-system' },
  }).catch(err => logger.error({ err: err.message, childId }, 'recurring child notify failed'));

  return { childId, status: finalStatus };
}
