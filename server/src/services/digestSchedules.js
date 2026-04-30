import cron from 'node-cron';
import { db } from '../db/index.js';

const VALID_STATUSES = new Set([
  'draft', 'submitted', 'approved', 'rejected', 'implemented', 'closed', 'rolled_back',
]);

export function isValidCron(expr) {
  return typeof expr === 'string' && cron.validate(expr);
}

function rowToSchedule(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    cronExpression: r.cron_expression,
    timezone: r.timezone,
    lookaheadDays: r.lookahead_days,
    statusFilter: JSON.parse(r.status_filter ?? '[]'),
    recipientUserIds: JSON.parse(r.recipient_user_ids ?? '[]'),
    recipientEmails: JSON.parse(r.recipient_emails ?? '[]'),
    enabled: Boolean(r.enabled),
    lastRunAt: r.last_run_at,
    lastSentAt: r.last_sent_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listSchedules() {
  return db.prepare('SELECT * FROM digest_schedules ORDER BY name').all().map(rowToSchedule);
}

export function getSchedule(id) {
  return rowToSchedule(db.prepare('SELECT * FROM digest_schedules WHERE id = ?').get(id));
}

export function listEnabledSchedules() {
  return db.prepare('SELECT * FROM digest_schedules WHERE enabled = 1').all().map(rowToSchedule);
}

export function validateScheduleInput(input, { partial = false } = {}) {
  if (!partial || 'cronExpression' in input) {
    if (!isValidCron(input.cronExpression)) return 'invalid cron expression';
  }
  if (!partial || 'timezone' in input) {
    if (typeof input.timezone !== 'string' || !input.timezone) return 'timezone is required';
  }
  if ('lookaheadDays' in input) {
    if (!Number.isInteger(input.lookaheadDays) || input.lookaheadDays < 1 || input.lookaheadDays > 365) {
      return 'lookaheadDays must be an integer between 1 and 365';
    }
  }
  if ('statusFilter' in input) {
    if (!Array.isArray(input.statusFilter)) return 'statusFilter must be an array';
    for (const s of input.statusFilter) {
      if (!VALID_STATUSES.has(s)) return `unknown status in filter: ${s}`;
    }
  }
  if ('recipientUserIds' in input) {
    if (!Array.isArray(input.recipientUserIds)) return 'recipientUserIds must be an array';
  }
  if ('recipientEmails' in input) {
    if (!Array.isArray(input.recipientEmails)) return 'recipientEmails must be an array';
    for (const e of input.recipientEmails) {
      if (typeof e !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return `invalid recipient email: ${e}`;
    }
  }
  const totalRecipients =
    (input.recipientUserIds?.length ?? 0) + (input.recipientEmails?.length ?? 0);
  if (!partial && totalRecipients === 0) return 'at least one recipient (user or email) is required';
  return null;
}

export function createSchedule(input) {
  const info = db.prepare(`
    INSERT INTO digest_schedules
      (name, cron_expression, timezone, lookahead_days, status_filter, recipient_user_ids, recipient_emails, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.cronExpression,
    input.timezone,
    input.lookaheadDays ?? 7,
    JSON.stringify(input.statusFilter ?? []),
    JSON.stringify(input.recipientUserIds ?? []),
    JSON.stringify(input.recipientEmails ?? []),
    input.enabled === false ? 0 : 1,
  );
  return getSchedule(Number(info.lastInsertRowid));
}

export function updateSchedule(id, patch) {
  const sets = [];
  const params = [];
  if ('name' in patch)             { sets.push('name = ?'); params.push(patch.name); }
  if ('cronExpression' in patch)   { sets.push('cron_expression = ?'); params.push(patch.cronExpression); }
  if ('timezone' in patch)         { sets.push('timezone = ?'); params.push(patch.timezone); }
  if ('lookaheadDays' in patch)    { sets.push('lookahead_days = ?'); params.push(patch.lookaheadDays); }
  if ('statusFilter' in patch)     { sets.push('status_filter = ?'); params.push(JSON.stringify(patch.statusFilter)); }
  if ('recipientUserIds' in patch) { sets.push('recipient_user_ids = ?'); params.push(JSON.stringify(patch.recipientUserIds)); }
  if ('recipientEmails' in patch)  { sets.push('recipient_emails = ?'); params.push(JSON.stringify(patch.recipientEmails)); }
  if ('enabled' in patch)          { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }

  if (!sets.length) return getSchedule(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE digest_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getSchedule(id);
}

export function deleteSchedule(id) {
  return db.prepare('DELETE FROM digest_schedules WHERE id = ?').run(id).changes > 0;
}

export function recordRun(id, { sent, error }) {
  db.prepare(`
    UPDATE digest_schedules
       SET last_run_at = datetime('now'),
           last_sent_at = CASE WHEN ? THEN datetime('now') ELSE last_sent_at END,
           last_error = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(sent ? 1 : 0, error ?? null, id);
}
