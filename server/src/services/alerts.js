import cronParser from 'cron-parser';
import { parseJsonOr } from "../db/json.js";
import { db } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendEmail, emailEnabled } from '../notifications/email.js';

// Defaults if config/notifications.json doesn't override them. These match
// what a small workshop would want — a 24h approval SLA, a 5-minute drift
// window so a recurring parent that misses a fire by ~the check-interval
// surfaces, and a check every 15 minutes (cheap, doesn't pile alerts up).
const DEFAULTS = {
  enabled: true,
  approvalSlaMinutes: 24 * 60,
  recurringDriftToleranceMinutes: 5,
  checkIntervalMinutes: 15,
  notifyEmails: [],
};

export function alertsConfig() {
  return { ...DEFAULTS, ...(config.notifications?.alerts ?? {}) };
}

export function alertsEnabled() {
  return alertsConfig().enabled !== false;
}

/**
 * Run both checks and return the alerts that fired (newly inserted) and
 * resolved (newly cleared) on this pass. Notification side-effects fire
 * for newly-inserted alerts only, so re-running this is idempotent.
 */
export async function runAlertChecks({ now = new Date() } = {}) {
  const cfg = alertsConfig();
  const fired = [];
  const resolved = [];

  // 1) approval SLA — per-change-type override wins; otherwise use the
  // global default. We pull the type's threshold via a single join rather
  // than per-row lookups.
  const submitted = db.prepare(`
    SELECT c.id, c.title, c.submitted_at, c.submitter_id, c.type_key,
           ct.approval_sla_minutes AS type_sla
    FROM changes c
    LEFT JOIN change_types ct ON ct.key = c.type_key
    WHERE c.status = 'submitted' AND c.submitted_at IS NOT NULL
  `).all();
  for (const c of submitted) {
    const slaMinutes = c.type_sla ?? cfg.approvalSlaMinutes;
    const cutoffMs = now.getTime() - slaMinutes * 60_000;
    const submittedMs = Date.parse(c.submitted_at.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(submittedMs) || submittedMs > cutoffMs) continue;
    if (raiseIfNew('approval_sla', c.id, {
      title: c.title,
      submittedAt: c.submitted_at,
      slaMinutes,
      typeKey: c.type_key,
    })) {
      fired.push({ kind: 'approval_sla', subjectChangeId: c.id, title: c.title });
    }
  }
  // Resolve approval_sla alerts whose changes are no longer in 'submitted'.
  const slaResolveIds = db.prepare(`
    SELECT a.id, a.subject_change_id FROM alerts a
    LEFT JOIN changes c ON c.id = a.subject_change_id
    WHERE a.kind = 'approval_sla' AND a.resolved_at IS NULL
      AND (c.id IS NULL OR c.status <> 'submitted')
  `).all();
  for (const r of slaResolveIds) {
    db.prepare(`UPDATE alerts SET resolved_at = datetime('now') WHERE id = ?`).run(r.id);
    resolved.push({ id: r.id, kind: 'approval_sla', subjectChangeId: r.subject_change_id });
  }

  // 2) recurring drift
  const parents = db.prepare(`
    SELECT id, title, recurrence_cron, recurrence_timezone, recurrence_last_fired_at, recurrence_enabled
    FROM changes WHERE is_recurring_parent = 1 AND recurrence_enabled = 1
  `).all();
  for (const p of parents) {
    let lastExpected;
    try {
      const it = cronParser.parseExpression(p.recurrence_cron, {
        currentDate: now,
        tz: p.recurrence_timezone || 'UTC',
      });
      lastExpected = it.prev().toDate();
    } catch (err) {
      logger.warn({ err: err.message, parentId: p.id, cron: p.recurrence_cron }, 'cron parse failed during drift check');
      continue;
    }
    const lastFiredMs = p.recurrence_last_fired_at
      ? Date.parse(p.recurrence_last_fired_at.replace(' ', 'T') + 'Z')
      : 0;
    const lastExpectedMs = lastExpected.getTime();
    const tol = cfg.recurringDriftToleranceMinutes * 60_000;
    const drifted = lastFiredMs < (lastExpectedMs - tol);
    if (drifted) {
      if (raiseIfNew('recurring_drift', p.id, {
        title: p.title,
        cron: p.recurrence_cron,
        timezone: p.recurrence_timezone,
        lastExpected: lastExpected.toISOString(),
        lastFiredAt: p.recurrence_last_fired_at,
      })) {
        fired.push({ kind: 'recurring_drift', subjectChangeId: p.id, title: p.title });
      }
    } else {
      // Latest fire caught up — resolve any open drift alert for this parent.
      const open = db.prepare(`
        SELECT id FROM alerts WHERE kind = 'recurring_drift' AND subject_change_id = ? AND resolved_at IS NULL
      `).get(p.id);
      if (open) {
        db.prepare(`UPDATE alerts SET resolved_at = datetime('now') WHERE id = ?`).run(open.id);
        resolved.push({ id: open.id, kind: 'recurring_drift', subjectChangeId: p.id });
      }
    }
  }

  // 3) notify on newly-fired alerts (best-effort — never throw to caller)
  if (fired.length > 0) {
    try {
      await notifyFired(fired);
      const ids = db.prepare(`
        SELECT id FROM alerts WHERE notified_at IS NULL AND resolved_at IS NULL
      `).all().map(r => r.id);
      const upd = db.prepare(`UPDATE alerts SET notified_at = datetime('now') WHERE id = ?`);
      for (const id of ids) upd.run(id);
    } catch (err) {
      logger.error({ err: err.message }, 'alert notification failed');
    }
  }

  return { fired, resolved };
}

function raiseIfNew(kind, subjectChangeId, details) {
  const open = db.prepare(`
    SELECT id FROM alerts
    WHERE kind = ? AND subject_change_id = ? AND resolved_at IS NULL
  `).get(kind, subjectChangeId);
  if (open) return false;
  db.prepare(`
    INSERT INTO alerts (kind, subject_change_id, details_json) VALUES (?, ?, ?)
  `).run(kind, subjectChangeId, JSON.stringify(details ?? {}));
  return true;
}

async function notifyFired(fired) {
  const cfg = alertsConfig();
  let recipients = cfg.notifyEmails ?? [];
  if (recipients.length === 0) {
    // Default to active admin emails.
    recipients = db.prepare(`
      SELECT email FROM users WHERE role = 'admin' AND active = 1 AND email IS NOT NULL AND email <> ''
    `).all().map(r => r.email);
  }
  if (recipients.length === 0 || !emailEnabled()) return;

  const lines = fired.map(f => {
    if (f.kind === 'approval_sla') return `• Approval SLA breached on #${f.subjectChangeId} "${f.title}"`;
    if (f.kind === 'recurring_drift') return `• Recurring change drift on #${f.subjectChangeId} "${f.title}" — expected fire missed`;
    return `• ${f.kind} on #${f.subjectChangeId}`;
  });
  const subject = fired.length === 1
    ? `[cambiar.world] alert: ${fired[0].kind.replace('_', ' ')} on #${fired[0].subjectChangeId}`
    : `[cambiar.world] ${fired.length} new alerts`;
  const text = [
    'cambiar.world raised the following alert(s):',
    '',
    ...lines,
    '',
    'Open the admin alerts page to review or resolve these:',
    `${(config.baseUrl ?? '').replace(/\/$/, '')}/admin/alerts`,
  ].join('\n');
  await sendEmail({ to: recipients, subject, text });
}

export function listAlerts({ status = 'active' } = {}) {
  const where = status === 'active'
    ? 'WHERE a.resolved_at IS NULL'
    : status === 'resolved' ? 'WHERE a.resolved_at IS NOT NULL'
    : '';
  return db.prepare(`
    SELECT a.id, a.kind, a.subject_change_id, a.fired_at, a.resolved_at, a.notified_at, a.details_json,
           c.title AS change_title, c.status AS change_status
    FROM alerts a
    LEFT JOIN changes c ON c.id = a.subject_change_id
    ${where}
    ORDER BY a.fired_at DESC, a.id DESC
    LIMIT 500
  `).all().map(r => ({
    id: r.id,
    kind: r.kind,
    subjectChangeId: r.subject_change_id,
    firedAt: r.fired_at,
    resolvedAt: r.resolved_at,
    notifiedAt: r.notified_at,
    details: parseJsonOr(r.details_json, null),
    change: r.subject_change_id ? { id: r.subject_change_id, title: r.change_title, status: r.change_status } : null,
  }));
}

export function resolveAlert(id) {
  const info = db.prepare(`
    UPDATE alerts SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL
  `).run(id);
  return info.changes > 0;
}

export function activeAlertCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM alerts WHERE resolved_at IS NULL').get().c;
}
