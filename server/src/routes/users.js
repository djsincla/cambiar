import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { hashPassword, validatePasswordStrength } from '../auth/passwords.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { config } from '../config.js';
import { setUserGroups, getUserGroups } from '../services/groups.js';

const router = Router();

router.use(requireAuth, blockIfPasswordChangeRequired);

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare(`
    SELECT id, username, email, display_name, role, source, active, must_change_password, phone, created_at, updated_at
    FROM users ORDER BY username
  `).all();
  res.json({ users: users.map(u => formatUser(u, getUserGroups(u.id))) });
});

const createSchema = z.object({
  username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'invalid username'),
  password: z.string().min(1),
  email: z.string().email().optional().nullable(),
  displayName: z.string().max(255).optional().nullable(),
  role: z.enum(['admin', 'approver', 'submitter']).default('submitter'),
  phone: z.string().max(32).optional().nullable(),
  groupIds: z.array(z.number().int().positive()).optional(),
});

router.post('/', requireRole('admin'), async (req, res) => {
  const parse = createSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const minLen = config.auth.local?.passwordMinLength ?? 10;
  const pwErr = validatePasswordStrength(parse.data.password, minLen);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(parse.data.username);
  if (exists) return res.status(409).json({ error: 'username already exists' });

  if (parse.data.groupIds?.length) {
    const found = db.prepare(`SELECT id FROM groups WHERE id IN (${parse.data.groupIds.map(() => '?').join(',')})`)
      .all(...parse.data.groupIds);
    if (found.length !== parse.data.groupIds.length) {
      return res.status(400).json({ error: 'one or more groupIds do not exist' });
    }
  }

  const hash = await hashPassword(parse.data.password);
  const info = db.prepare(`
    INSERT INTO users (username, email, display_name, password_hash, source, role, phone, must_change_password)
    VALUES (?, ?, ?, ?, 'local', ?, ?, 1)
  `).run(parse.data.username, parse.data.email ?? null, parse.data.displayName ?? null, hash, parse.data.role, parse.data.phone ?? null);

  const newId = Number(info.lastInsertRowid);
  if (parse.data.groupIds?.length) setUserGroups(newId, parse.data.groupIds);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
  res.status(201).json({ user: formatUser(user, getUserGroups(newId)) });
});

router.get('/:id', requireRole('admin'), (req, res) => {
  const user = db.prepare(`
    SELECT id, username, email, display_name, role, source, active, must_change_password, phone, created_at, updated_at
    FROM users WHERE id = ?
  `).get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ user: formatUser(user, getUserGroups(user.id)) });
});

const patchSchema = z.object({
  email: z.string().email().nullable().optional(),
  displayName: z.string().max(255).nullable().optional(),
  role: z.enum(['admin', 'approver', 'submitter']).optional(),
  active: z.boolean().optional(),
  phone: z.string().max(32).nullable().optional(),
  groupIds: z.array(z.number().int().positive()).optional(),
}).strict();

router.patch('/:id', requireRole('admin'), (req, res) => {
  const parse = patchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  if (parse.data.role && parse.data.role !== 'admin' && existing.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'cannot demote last active admin' });
  }
  if (parse.data.active === false && existing.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'cannot disable last active admin' });
  }

  if (parse.data.groupIds) {
    const ids = parse.data.groupIds;
    if (ids.length > 0) {
      const found = db.prepare(`SELECT id FROM groups WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids);
      if (found.length !== ids.length) {
        return res.status(400).json({ error: 'one or more groupIds do not exist' });
      }
    }
  }

  const sets = [];
  const params = [];
  if ('email' in parse.data) { sets.push('email = ?'); params.push(parse.data.email); }
  if ('displayName' in parse.data) { sets.push('display_name = ?'); params.push(parse.data.displayName); }
  if ('role' in parse.data) { sets.push('role = ?'); params.push(parse.data.role); }
  if ('active' in parse.data) { sets.push('active = ?'); params.push(parse.data.active ? 1 : 0); }
  if ('phone' in parse.data) { sets.push('phone = ?'); params.push(parse.data.phone); }
  const hasGroupIds = 'groupIds' in parse.data;
  if (!sets.length && !hasGroupIds) return res.status(400).json({ error: 'nothing to update' });

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  if (hasGroupIds) setUserGroups(id, parse.data.groupIds);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ user: formatUser(user, getUserGroups(id)) });
});

router.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id, source FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.source !== 'local') return res.status(400).json({ error: 'cannot reset password of AD user' });

  const newPassword = req.body?.newPassword;
  const minLen = config.auth.local?.passwordMinLength ?? 10;
  const pwErr = validatePasswordStrength(newPassword, minLen);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const hash = await hashPassword(newPassword);
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`)
    .run(hash, id);
  res.json({ ok: true });
});

function formatUser(u, groups = []) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    source: u.source,
    active: Boolean(u.active),
    mustChangePassword: Boolean(u.must_change_password),
    phone: u.phone,
    groups,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

export default router;
