import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';

const FEED_NAME = 'cambiar.world — Upcoming Changes';
// How far ahead to publish. Calendar apps cache a long time, so we publish
// a generous window. Past changes within 7 days are kept so the calendar
// view still shows recent context.
const PAST_WINDOW_DAYS = 7;
const FUTURE_WINDOW_DAYS = 90;

// Statuses worth showing in a calendar. Drafts aren't real commitments.
// Closed/rolled_back/rejected are done — past their value as a heads-up.
const VISIBLE_STATUSES = ['submitted', 'approved', 'in_progress', 'implemented'];

export function generateIcalToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Look up the user owning the given token, or return null. */
export function findUserByIcalToken(token) {
  if (!token || typeof token !== 'string' || token.length < 8) return null;
  return db.prepare(`SELECT id, username, active FROM users WHERE ical_token = ?`).get(token);
}

/** Get-or-create the user's iCal token. Idempotent — only creates once. */
export function getOrCreateIcalToken(userId) {
  const existing = db.prepare('SELECT ical_token FROM users WHERE id = ?').get(userId);
  if (existing?.ical_token) return existing.ical_token;
  const token = generateIcalToken();
  db.prepare('UPDATE users SET ical_token = ? WHERE id = ?').run(token, userId);
  return token;
}

/** Force-rotate the user's token. Returns the new value. */
export function rotateIcalToken(userId) {
  const token = generateIcalToken();
  db.prepare('UPDATE users SET ical_token = ? WHERE id = ?').run(token, userId);
  return token;
}

/** Render a list of changes as an iCalendar (RFC 5545) document. */
export function buildIcalFeed({ now = new Date() } = {}) {
  const past = new Date(now.getTime() - PAST_WINDOW_DAYS * 86_400_000).toISOString();
  const future = new Date(now.getTime() + FUTURE_WINDOW_DAYS * 86_400_000).toISOString();

  const placeholders = VISIBLE_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, title, description, status, scheduled_at, planned_duration_minutes, updated_at, type_key
    FROM changes
    WHERE scheduled_at IS NOT NULL
      AND scheduled_at >= ? AND scheduled_at <= ?
      AND status IN (${placeholders})
      AND is_recurring_parent = 0
    ORDER BY scheduled_at ASC
  `).all(past, future, ...VISIBLE_STATUSES);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//cambiar.world//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(FEED_NAME)}`,
    `X-WR-CALDESC:${escapeText('Upcoming changes from cambiar.world.')}`,
    `X-WR-TIMEZONE:UTC`,
  ];

  const stamp = formatIcsDate(now);
  for (const r of rows) {
    const start = new Date(r.scheduled_at);
    const durMin = r.planned_duration_minutes ?? 30;
    const end = new Date(start.getTime() + durMin * 60_000);

    const summary = `[cambiar.world #${r.id}] ${r.title}`;
    const url = changeUrl(r.id);
    const descriptionParts = [
      r.description ? r.description.trim() : '',
      `Status: ${r.status}`,
      `Type: ${r.type_key}`,
      `Open in cambiar.world: ${url}`,
    ].filter(Boolean);

    lines.push(
      'BEGIN:VEVENT',
      `UID:cambiar-change-${r.id}@${hostFromBaseUrl()}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsDate(start)}`,
      `DTEND:${formatIcsDate(end)}`,
      `LAST-MODIFIED:${formatIcsDate(new Date(r.updated_at?.replace(' ', 'T') + 'Z' || now))}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(descriptionParts.join('\\n'))}`,
      `URL:${url}`,
      `STATUS:${icsStatus(r.status)}`,
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  // RFC 5545 mandates CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}

function icsStatus(s) {
  // CONFIRMED is the closest analogue once approved/in-progress/done.
  // submitted = TENTATIVE (not yet committed).
  return s === 'submitted' ? 'TENTATIVE' : 'CONFIRMED';
}

function formatIcsDate(d) {
  // YYYYMMDDTHHMMSSZ — ICS UTC format.
  const iso = d.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function changeUrl(id) {
  const base = (config.baseUrl || '').replace(/\/$/, '');
  return base ? `${base}/changes/${id}` : `/changes/${id}`;
}

function hostFromBaseUrl() {
  try {
    return new URL(config.baseUrl || 'http://localhost').host;
  } catch {
    return 'cambiar';
  }
}
