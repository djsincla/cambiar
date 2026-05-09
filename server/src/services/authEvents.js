import { db } from '../db/index.js';

// Lockout policy. Tunable here; small workshop default.
//   THRESHOLD failures within WINDOW_MIN locks the account for DURATION_MIN.
// Lock is by username (not IP), so an attacker who knows the admin username
// can deliberately lock them out — this is acceptable because:
//   1. Lock is 15 min, not permanent.
//   2. Admin can clear it via POST /api/auth/clear-lock or the reset-admin CLI.
//   3. The DoS-by-username is well within "small workshop" threat model.
const THRESHOLD = 5;
const WINDOW_MIN = 15;
const DURATION_MIN = 15;

const UA_TRUNCATE = 256;

export function recordEvent({ username, ip, userAgent, outcome, source, userId = null }) {
  db.prepare(`
    INSERT INTO auth_events (username, ip, user_agent, outcome, source, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    String(username ?? ''),
    ip ?? null,
    userAgent ? String(userAgent).slice(0, UA_TRUNCATE) : null,
    outcome,
    source,
    userId,
  );
}

export function recentFailureCount(username, withinMinutes = WINDOW_MIN) {
  const r = db.prepare(`
    SELECT COUNT(*) AS c FROM auth_events
    WHERE username = ?
      AND outcome IN ('invalid_credentials', 'account_locked')
      AND created_at >= datetime('now', ? )
  `).get(username, `-${withinMinutes} minutes`);
  return Number(r.c) || 0;
}

/** Apply lockout to a user if recent failure count crossed the threshold.
 *  Skipped under CAMBIAR_DISABLE_LOCKOUT=1 so the Playwright suite (which
 *  legitimately racks up failed-then-corrected admin logins via its
 *  password-race helper) doesn't lock itself out mid-run. The audit
 *  events are still recorded; only the actual lock action is bypassed. */
export function maybeLockUser(userId, username) {
  if (process.env.CAMBIAR_DISABLE_LOCKOUT === '1') return false;
  if (recentFailureCount(username) < THRESHOLD) return false;
  const until = new Date(Date.now() + DURATION_MIN * 60_000).toISOString();
  db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(until, userId);
  return true;
}

/** True if the user's locked_until is in the future. */
export function isUserLocked(user) {
  if (!user?.locked_until) return false;
  return Date.parse(user.locked_until) > Date.now();
}

/** Clear lock state. Called on successful login + by admin endpoint. */
export function clearLock(userId) {
  db.prepare('UPDATE users SET locked_until = NULL WHERE id = ?').run(userId);
}

/** List recent auth events for the admin page. */
export function listRecentEvents({ limit = 200, outcome = null } = {}) {
  let sql = `
    SELECT a.id, a.username, a.ip, a.user_agent, a.outcome, a.source, a.user_id, a.created_at,
           u.display_name AS user_display_name
    FROM auth_events a
    LEFT JOIN users u ON u.id = a.user_id
  `;
  const params = [];
  if (outcome) { sql += ' WHERE a.outcome = ?'; params.push(outcome); }
  sql += ' ORDER BY a.id DESC LIMIT ?';
  params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
  return db.prepare(sql).all(...params).map(r => ({
    id: r.id,
    username: r.username,
    ip: r.ip,
    userAgent: r.user_agent,
    outcome: r.outcome,
    source: r.source,
    user: r.user_id ? { id: r.user_id, displayName: r.user_display_name } : null,
    createdAt: r.created_at,
  }));
}

export const policy = { threshold: THRESHOLD, windowMinutes: WINDOW_MIN, durationMinutes: DURATION_MIN };
