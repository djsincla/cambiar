// Prometheus exposition. text/plain; version=0.0.4 — the format Prometheus
// scrapers expect.
//
// Authentication: admin-only via the existing JWT middleware. Prometheus
// scrapes typically use a long-lived bearer token (Authorization: Bearer …);
// since cambiar's JWTs are short-lived (12 h default), this works for ad-hoc
// scraping but operators with continuous monitoring should put a reverse-
// proxy auth in front. Documented in the operator notes.
//
// What we expose, deliberately scoped to ops-relevant aggregates:
//   cambiar_users_total{role,active}
//   cambiar_changes_total{status}
//   cambiar_active_alerts_total
//   cambiar_locked_users_total
//   cambiar_login_attempts_recent_total{outcome}
//   cambiar_scheduler_last_tick_age_seconds{name}    (gauge; -1 = never ticked)
//
// HTTP-request histograms are out of scope here — those need pino-http
// hooks, and operators usually get them from the reverse proxy anyway.

import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { getAllTicks } from '../services/schedulerHealth.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired, requireRole('admin'));

router.get('/', (_req, res) => {
  const lines = [];

  // ---- users ----
  lines.push('# HELP cambiar_users_total Total users by role and active status.');
  lines.push('# TYPE cambiar_users_total gauge');
  const userCounts = db.prepare(`
    SELECT role, active, COUNT(*) AS c FROM users GROUP BY role, active
  `).all();
  for (const r of userCounts) {
    lines.push(`cambiar_users_total{role="${esc(r.role)}",active="${r.active ? 'true' : 'false'}"} ${r.c}`);
  }

  // ---- locked users ----
  lines.push('# HELP cambiar_locked_users_total Local users with an active lockout (locked_until in the future).');
  lines.push('# TYPE cambiar_locked_users_total gauge');
  const locked = db.prepare(`
    SELECT COUNT(*) AS c FROM users WHERE locked_until IS NOT NULL AND locked_until > datetime('now')
  `).get();
  lines.push(`cambiar_locked_users_total ${locked.c}`);

  // ---- changes ----
  lines.push('# HELP cambiar_changes_total Total changes by status (excludes recurring parents).');
  lines.push('# TYPE cambiar_changes_total gauge');
  const changeCounts = db.prepare(`
    SELECT status, COUNT(*) AS c FROM changes WHERE is_recurring_parent = 0 GROUP BY status
  `).all();
  for (const r of changeCounts) {
    lines.push(`cambiar_changes_total{status="${esc(r.status)}"} ${r.c}`);
  }

  // ---- active alerts ----
  lines.push('# HELP cambiar_active_alerts_total Operational alerts that are currently unresolved.');
  lines.push('# TYPE cambiar_active_alerts_total gauge');
  const activeAlerts = db.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE resolved_at IS NULL`).get();
  lines.push(`cambiar_active_alerts_total ${activeAlerts.c}`);

  // ---- recent login attempts (last hour) ----
  lines.push('# HELP cambiar_login_attempts_recent_total Login attempts in the last hour, by outcome.');
  lines.push('# TYPE cambiar_login_attempts_recent_total gauge');
  const loginCounts = db.prepare(`
    SELECT outcome, COUNT(*) AS c FROM auth_events
    WHERE created_at >= datetime('now', '-1 hour')
    GROUP BY outcome
  `).all();
  for (const r of loginCounts) {
    lines.push(`cambiar_login_attempts_recent_total{outcome="${esc(r.outcome)}"} ${r.c}`);
  }

  // ---- scheduler liveness ----
  lines.push('# HELP cambiar_scheduler_last_tick_age_seconds Seconds since each scheduler last fired (-1 if never since start).');
  lines.push('# TYPE cambiar_scheduler_last_tick_age_seconds gauge');
  const ticks = getAllTicks();
  const now = Date.now();
  for (const name of ['digest', 'recurring', 'email', 'alerts', 'gcal']) {
    const t = ticks[name];
    const ageSec = t ? Math.max(0, Math.round((now - Date.parse(t)) / 1000)) : -1;
    lines.push(`cambiar_scheduler_last_tick_age_seconds{name="${name}"} ${ageSec}`);
  }

  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  // Trailing newline per Prometheus exposition format.
  res.send(lines.join('\n') + '\n');
});

// Escape label values per the Prometheus exposition format. Quotes,
// backslashes, and newlines need backslash-escaping. Real-world strings
// here (role / status / outcome) come from CHECK-constrained columns so
// the escape is mostly a defensive nicety.
function esc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

export default router;
