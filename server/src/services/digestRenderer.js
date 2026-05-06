import { db } from '../db/index.js';
import { sendEmail, emailEnabled } from '../notifications/email.js';
import { recordRun } from './digestSchedules.js';
import { logger } from '../logger.js';

/**
 * Load the changes that should appear in the digest for a given schedule.
 * "scheduled within the next N days, status in the filter (or any if empty)".
 * Includes changes scheduled for today.
 */
export function loadDigestChanges(schedule, { now = new Date() } = {}) {
  const fromIso = now.toISOString();
  const to = new Date(now.getTime() + schedule.lookaheadDays * 24 * 3600 * 1000);
  const toIso = to.toISOString();

  const wheres = [
    `c.scheduled_at IS NOT NULL`,
    `c.scheduled_at >= ?`,
    `c.scheduled_at <= ?`,
  ];
  const params = [fromIso, toIso];
  const sf = schedule.statusFilter ?? [];
  if (sf.length) {
    wheres.push(`c.status IN (${sf.map(() => '?').join(',')})`);
    params.push(...sf);
  }

  return db.prepare(`
    SELECT c.*, u.username AS submitter_username, u.display_name AS submitter_display_name
    FROM changes c JOIN users u ON u.id = c.submitter_id
    WHERE ${wheres.join(' AND ')}
    ORDER BY c.scheduled_at ASC
  `).all(...params);
}

/**
 * Resolve recipient emails. User IDs → users.email (where active and not null);
 * unioned with the free-form emails, deduped.
 */
export function resolveRecipientEmails(schedule) {
  const out = new Set();
  for (const e of schedule.recipientEmails ?? []) out.add(e);
  const ids = schedule.recipientUserIds ?? [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT email FROM users WHERE id IN (${placeholders}) AND active = 1 AND email IS NOT NULL AND email <> ''
    `).all(...ids);
    for (const r of rows) out.add(r.email);
  }
  return [...out];
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function groupByDay(rows) {
  const groups = new Map(); // day-string → rows
  for (const r of rows) {
    const day = (r.scheduled_at ?? '').slice(0, 10) || 'unscheduled';
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(r);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function renderDigest(schedule, changes) {
  const groups = groupByDay(changes);
  const subject = `[cambiar.world] ${schedule.name} — ${changes.length} change${changes.length === 1 ? '' : 's'} in the next ${schedule.lookaheadDays} day${schedule.lookaheadDays === 1 ? '' : 's'}`;

  if (changes.length === 0) {
    const text = `No changes scheduled in the next ${schedule.lookaheadDays} days.`;
    const html = `<p>${escapeHtml(text)}</p>`;
    return { subject, text, html };
  }

  const textLines = [`cambiar.world digest: ${schedule.name}`, ''];
  let html = `<h2 style="font-family:system-ui,sans-serif">${escapeHtml(schedule.name)}</h2>`;
  for (const [day, items] of groups) {
    textLines.push(`== ${day} ==`);
    html += `<h3 style="font-family:system-ui,sans-serif;border-bottom:1px solid #ccc;padding-bottom:4px">${escapeHtml(day)}</h3><ul style="font-family:system-ui,sans-serif">`;
    for (const c of items) {
      const submitter = c.submitter_display_name || c.submitter_username;
      const time = (c.scheduled_at ?? '').slice(11, 16);
      const line = `#${c.id}  ${time ? time + '  ' : ''}[${c.status}]  ${c.title}  (by ${submitter}, type: ${c.type_key})`;
      textLines.push(line);
      html += `<li><strong>#${c.id}</strong> ${escapeHtml(time ? time + ' ' : '')}<span style="text-transform:uppercase;font-size:11px;color:#666">[${escapeHtml(c.status)}]</span> ${escapeHtml(c.title)} <span style="color:#666">(by ${escapeHtml(submitter)}, type: ${escapeHtml(c.type_key)})</span></li>`;
    }
    textLines.push('');
    html += '</ul>';
  }

  return { subject, text: textLines.join('\n'), html };
}

/**
 * Run a digest end-to-end: load changes, render, send. Updates the schedule
 * row with last_run_at / last_sent_at / last_error. Returns a small report.
 */
export async function runDigest(schedule, opts = {}) {
  const changes = loadDigestChanges(schedule, opts);
  const recipients = resolveRecipientEmails(schedule);

  if (recipients.length === 0) {
    const error = 'no recipient emails resolved (users have no email and no free-form emails configured)';
    recordRun(schedule.id, { sent: false, error });
    return { ok: false, sent: false, error, changes: changes.length, recipients };
  }
  if (!emailEnabled()) {
    const error = 'email channel is disabled in config/notifications.json';
    recordRun(schedule.id, { sent: false, error });
    return { ok: false, sent: false, error, changes: changes.length, recipients };
  }

  const { subject, text, html } = renderDigest(schedule, changes);
  try {
    await sendEmail({ to: recipients, subject, text, html });
    recordRun(schedule.id, { sent: true, error: null });
    logger.info({ scheduleId: schedule.id, name: schedule.name, recipients: recipients.length, changes: changes.length }, 'digest sent');
    return { ok: true, sent: true, error: null, changes: changes.length, recipients };
  } catch (err) {
    recordRun(schedule.id, { sent: false, error: err.message });
    logger.error({ scheduleId: schedule.id, err: err.message }, 'digest send failed');
    return { ok: false, sent: false, error: err.message, changes: changes.length, recipients };
  }
}
