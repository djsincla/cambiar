import { db } from '../db/index.js';

function rowToGroup(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    memberCount: r.member_count ?? null,
    adManaged: Boolean(r.ad_managed),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function isAdManaged(id) {
  const r = db.prepare('SELECT ad_managed FROM groups WHERE id = ?').get(id);
  return r ? Boolean(r.ad_managed) : false;
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

/**
 * Return the user IDs eligible to approve a change of a given type. Used by
 * both the inbox query and the notification recipient list — same predicate
 * everywhere, so what gets emailed matches what shows up in inboxes.
 *
 * Returned set always includes admins (override). For types with assigned
 * approver groups, also includes group members. For types with NO assigned
 * groups, falls back to the legacy 'approver' role.
 *
 * Excludes inactive users and the optional `excludeUserId` (typically the
 * submitter).
 */
export function eligibleApproverIds({ changeTypeId, hasApproverGroups, excludeUserId = null }) {
  const params = [];
  const conditions = [`u.active = 1`];
  if (excludeUserId != null) { conditions.push('u.id <> ?'); params.push(excludeUserId); }

  const groupClause = hasApproverGroups
    ? `EXISTS (
         SELECT 1 FROM user_groups ug
         JOIN change_type_approver_groups ctg ON ctg.group_id = ug.group_id
         WHERE ug.user_id = u.id AND ctg.change_type_id = ?
       )`
    : `u.role = 'approver'`;
  if (hasApproverGroups) params.push(changeTypeId);

  const sql = `
    SELECT DISTINCT u.id FROM users u
    WHERE ${conditions.join(' AND ')}
      AND (u.role = 'admin' OR ${groupClause})
  `;
  return db.prepare(sql).all(...params).map(r => r.id);
}

/**
 * List of changes currently awaiting approval by `userId`. Returns full
 * change rows ordered by submitted_at ASC (oldest first — queue semantics).
 *
 * Eligibility (same predicate as eligibleApproverIds):
 *   - status = 'submitted'
 *   - user is not the submitter
 *   - user is admin (override), OR
 *   - the change type has approver groups and user is in one, OR
 *   - the change type has no groups and user has 'approver' role (legacy)
 */
export function awaitingApprovalChanges(user) {
  // Admin override: everything submitted that isn't their own.
  if (user.role === 'admin') {
    return db.prepare(`
      SELECT c.*, u.username AS submitter_username, u.display_name AS submitter_display_name
      FROM changes c
      JOIN users u ON u.id = c.submitter_id
      WHERE c.status = 'submitted' AND c.submitter_id <> ?
      ORDER BY COALESCE(c.submitted_at, c.updated_at) ASC, c.id ASC
    `).all(user.id);
  }

  // Non-admin: union of (group-eligible) and (legacy approver-role on
  // unassigned types). Single query with EXISTS keeps it tight.
  return db.prepare(`
    SELECT c.*, u.username AS submitter_username, u.display_name AS submitter_display_name
    FROM changes c
    JOIN users u ON u.id = c.submitter_id
    JOIN change_types ct ON ct.key = c.type_key
    WHERE c.status = 'submitted'
      AND c.submitter_id <> ?
      AND (
        EXISTS (
          SELECT 1 FROM user_groups ug
          JOIN change_type_approver_groups ctg ON ctg.group_id = ug.group_id
          WHERE ug.user_id = ? AND ctg.change_type_id = ct.id
        )
        OR (
          ? = 'approver'
          AND NOT EXISTS (
            SELECT 1 FROM change_type_approver_groups ctg2
            WHERE ctg2.change_type_id = ct.id
          )
        )
      )
    ORDER BY COALESCE(c.submitted_at, c.updated_at) ASC, c.id ASC
  `).all(user.id, user.id, user.role);
}
