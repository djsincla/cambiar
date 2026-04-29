import { db } from '../db/index.js';

function rowToGroup(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    memberCount: r.member_count ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listGroups() {
  return db.prepare(`
    SELECT g.*, COUNT(ug.user_id) AS member_count
    FROM groups g LEFT JOIN user_groups ug ON ug.group_id = g.id
    GROUP BY g.id ORDER BY g.name
  `).all().map(rowToGroup);
}

export function getGroupById(id) {
  const r = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!r) return null;
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.email, u.role
    FROM user_groups ug JOIN users u ON u.id = ug.user_id
    WHERE ug.group_id = ? ORDER BY u.username
  `).all(id);
  return {
    ...rowToGroup(r),
    members: members.map(m => ({
      id: m.id, username: m.username, displayName: m.display_name, email: m.email, role: m.role,
    })),
  };
}

export function createGroup({ name, description }) {
  const info = db.prepare('INSERT INTO groups (name, description) VALUES (?, ?)').run(name, description ?? null);
  return getGroupById(Number(info.lastInsertRowid));
}

export function updateGroup(id, patch) {
  const sets = [];
  const params = [];
  if ('name' in patch) { sets.push('name = ?'); params.push(patch.name); }
  if ('description' in patch) { sets.push('description = ?'); params.push(patch.description); }
  if (!sets.length) return getGroupById(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  const info = db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return info.changes > 0 ? getGroupById(id) : null;
}

export function deleteGroup(id) {
  const info = db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  return info.changes > 0;
}

export function setGroupMembers(groupId, userIds) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_groups WHERE group_id = ?').run(groupId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
    for (const uid of userIds) ins.run(uid, groupId);
  });
  tx();
}

export function setUserGroups(userId, groupIds) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
    for (const gid of groupIds) ins.run(userId, gid);
  });
  tx();
}

export function getUserGroups(userId) {
  return db.prepare(`
    SELECT g.id, g.name, g.description FROM user_groups ug
    JOIN groups g ON g.id = ug.group_id
    WHERE ug.user_id = ? ORDER BY g.name
  `).all(userId);
}

export function getUserGroupIdSet(userId) {
  return new Set(db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?').all(userId).map(r => r.group_id));
}

/**
 * Approval rule (any-one-group):
 * - Submitter can never approve their own change.
 * - Admin can always approve (override, regardless of groups).
 * - If the change type has approver groups assigned, the user must be a member
 *   of at least one of them.
 * - Legacy fallback: if no groups are assigned, users with role 'approver' can approve.
 */
export function userCanApprove({ user, change, changeType }) {
  if (change.submitter_id === user.id) return { allowed: false, reason: 'submitter cannot approve their own change' };
  if (user.role === 'admin') return { allowed: true };

  const approverGroups = changeType?.approverGroups ?? [];
  if (approverGroups.length === 0) {
    // Legacy: no groups configured for this change type — fall back to role.
    if (user.role === 'approver') return { allowed: true };
    return { allowed: false, reason: 'no approver groups assigned and you do not have approver role' };
  }
  const userGroups = getUserGroupIdSet(user.id);
  const ok = approverGroups.some(g => userGroups.has(g.id));
  return ok
    ? { allowed: true }
    : { allowed: false, reason: 'you are not a member of any approver group for this change type' };
}
