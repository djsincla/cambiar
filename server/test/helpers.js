import bcrypt from 'bcrypt';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { createApp } from '../src/app.js';

let _app;
export function getApp() {
  if (!_app) _app = createApp({ httpLogger: false });
  return _app;
}

/**
 * Wipe all data and reseed a known fixture set.
 * Order matters because of FK constraints.
 *
 * change_types are PRESERVED across resets (seeded once from config) so tests
 * that rely on the seeded catalog don't need to reseed each time. Tests that
 * mutate change_types should clean up after themselves.
 */
export function resetDb() {
  db.exec(`
    DELETE FROM auth_events;
    DELETE FROM alerts;
    DELETE FROM audit_log;
    DELETE FROM approvals;
    DELETE FROM change_attachments;
    DELETE FROM change_notes;
    DELETE FROM email_log;
    DELETE FROM changes;
    DELETE FROM change_templates;
    DELETE FROM change_type_approver_groups;
    DELETE FROM user_groups;
    DELETE FROM groups;
    DELETE FROM digest_schedules;
    DELETE FROM email_rules;
    DELETE FROM users;
    -- Reset mutations on the seeded change_types catalog to its initial state.
    -- (We keep the rows themselves so tests don't have to reseed.)
    UPDATE change_types SET auto_approve = 0, active = 1;
  `);
  // Reset sequences for the wiped tables (but not change_types).
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('users', 'changes', 'approvals', 'audit_log', 'groups', 'digest_schedules', 'change_notes', 'change_attachments', 'change_templates', 'email_rules', 'email_log')`);

  // Bootstrap admin (admin/admin, must change password) — same as runtime bootstrap.
  const hash = bcrypt.hashSync('admin', 4);
  db.prepare(`
    INSERT INTO users (username, display_name, password_hash, source, role, must_change_password)
    VALUES ('admin', 'Administrator', ?, 'local', 'admin', 1)
  `).run(hash);
}

/** Create a group with the given name. */
export function createGroup({ name, description = null } = {}) {
  if (!name) throw new Error('group name required');
  const info = db.prepare('INSERT INTO groups (name, description) VALUES (?, ?)').run(name, description);
  return { id: Number(info.lastInsertRowid), name, description };
}

/** Add a user to a group. */
export function addUserToGroup(userId, groupId) {
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, groupId);
}

/** Assign approver groups to a change type by key. */
export function setApproverGroups(changeTypeKey, groupIds) {
  const ct = db.prepare('SELECT id FROM change_types WHERE key = ?').get(changeTypeKey);
  if (!ct) throw new Error(`unknown change type: ${changeTypeKey}`);
  db.prepare('DELETE FROM change_type_approver_groups WHERE change_type_id = ?').run(ct.id);
  const ins = db.prepare('INSERT INTO change_type_approver_groups (change_type_id, group_id) VALUES (?, ?)');
  for (const gid of groupIds) ins.run(ct.id, gid);
}

/**
 * Create a local user with the given attrs. Returns { id, username, password (plain) }.
 * Uses a low bcrypt cost factor for speed; tests are not security-critical.
 */
export function createUser({
  username,
  password = 'TestPass1234',
  email = null,
  displayName = null,
  role = 'submitter',
  active = 1,
  mustChangePassword = 0,
  phone = null,
} = {}) {
  if (!username) throw new Error('username required');
  const hash = bcrypt.hashSync(password, 4);
  const info = db.prepare(`
    INSERT INTO users (username, email, display_name, password_hash, source, role, active, must_change_password, phone)
    VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?)
  `).run(username, email, displayName, hash, role, active, mustChangePassword, phone);
  return { id: Number(info.lastInsertRowid), username, password };
}

/**
 * Log in via the API and return a supertest agent that retains the session cookie.
 */
export async function agentFor(username, password) {
  const agent = request.agent(getApp());
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

/** A bare supertest client (no cookies). */
export function client() {
  return request(getApp());
}

/** Fetch a row from a table for assertions. */
export function row(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function rows(sql, ...params) {
  return db.prepare(sql).all(...params);
}
