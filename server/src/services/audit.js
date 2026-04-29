import { db } from '../db/index.js';

export function recordAudit({ changeId, userId, action, fromStatus, toStatus, details }) {
  db.prepare(`
    INSERT INTO audit_log (change_id, user_id, action, from_status, to_status, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(changeId, userId ?? null, action, fromStatus ?? null, toStatus ?? null,
    details ? JSON.stringify(details) : null);
}

export function loadAudit(changeId) {
  const rows = db.prepare(`
    SELECT a.*, u.username AS user_username, u.display_name AS user_display_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.change_id = ? ORDER BY a.id ASC
  `).all(changeId);
  return rows.map(r => ({
    id: r.id,
    action: r.action,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    details: r.details ? JSON.parse(r.details) : null,
    user: r.user_username ? { id: r.user_id, username: r.user_username, displayName: r.user_display_name } : null,
    createdAt: r.created_at,
  }));
}
