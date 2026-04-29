import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, client, row, rows } from './helpers.js';

async function adminAgent() {
  // Bootstrap admin must change pw before reaching protected routes.
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('GET /api/users', () => {
  beforeEach(resetDb);

  test('admin sees all users', async () => {
    createUser({ username: 'bob' });
    createUser({ username: 'carol', role: 'approver' });
    const a = await adminAgent();
    const res = await a.get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body.users.map(u => u.username).sort()).toEqual(['admin', 'bob', 'carol']);
  });

  test('non-admin gets 403', async () => {
    createUser({ username: 'bob' });
    const a = await agentFor('bob', 'TestPass1234');
    const res = await a.get('/api/users');
    expect(res.status).toBe(403);
  });

  test('unauthenticated gets 401', async () => {
    const res = await client().get('/api/users');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/users', () => {
  beforeEach(resetDb);

  test('admin creates a user that must change password', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/users').send({
      username: 'dave', password: 'DavePass1234', email: 'dave@x.com',
      displayName: 'Dave', role: 'approver', phone: '+15551234567',
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      username: 'dave', email: 'dave@x.com', displayName: 'Dave',
      role: 'approver', source: 'local', active: true, mustChangePassword: true, phone: '+15551234567',
    });
  });

  test('rejects duplicate username', async () => {
    const a = await adminAgent();
    await a.post('/api/users').send({ username: 'eve', password: 'EvePass12345' });
    const res = await a.post('/api/users').send({ username: 'eve', password: 'EvePass12345' });
    expect(res.status).toBe(409);
  });

  test('rejects invalid username', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/users').send({ username: 'with spaces', password: 'EvePass12345' });
    expect(res.status).toBe(400);
  });

  test('rejects weak password', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/users').send({ username: 'frank', password: 'short' });
    expect(res.status).toBe(400);
  });

  test('non-admin cannot create users', async () => {
    createUser({ username: 'bob' });
    const a = await agentFor('bob', 'TestPass1234');
    const res = await a.post('/api/users').send({ username: 'mallory', password: 'MalloryX1234' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/users/:id', () => {
  beforeEach(resetDb);

  test('admin updates role and active', async () => {
    const u = createUser({ username: 'bob' });
    const a = await adminAgent();
    const res = await a.patch(`/api/users/${u.id}`).send({ role: 'approver', active: false });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('approver');
    expect(res.body.user.active).toBe(false);
  });

  test('cannot demote last active admin', async () => {
    const a = await adminAgent();
    const adminId = row('SELECT id FROM users WHERE username = ?', 'admin').id;
    const res = await a.patch(`/api/users/${adminId}`).send({ role: 'submitter' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last active admin/);
  });

  test('cannot disable last active admin', async () => {
    const a = await adminAgent();
    const adminId = row('SELECT id FROM users WHERE username = ?', 'admin').id;
    const res = await a.patch(`/api/users/${adminId}`).send({ active: false });
    expect(res.status).toBe(400);
  });

  test('CAN demote admin if another active admin exists', async () => {
    createUser({ username: 'admin2', role: 'admin' });
    const a = await adminAgent();
    const adminId = row('SELECT id FROM users WHERE username = ?', 'admin').id;
    const res = await a.patch(`/api/users/${adminId}`).send({ role: 'submitter' });
    expect(res.status).toBe(200);
  });

  test('rejects unknown fields (strict)', async () => {
    const u = createUser({ username: 'bob' });
    const a = await adminAgent();
    const res = await a.patch(`/api/users/${u.id}`).send({ password: 'hacked' });
    expect(res.status).toBe(400);
  });

  test('404 for missing user', async () => {
    const a = await adminAgent();
    const res = await a.patch('/api/users/9999').send({ role: 'admin' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/users/:id/reset-password', () => {
  beforeEach(resetDb);

  test('admin resets local user password and forces change', async () => {
    const u = createUser({ username: 'bob' });
    const a = await adminAgent();
    const res = await a.post(`/api/users/${u.id}/reset-password`).send({ newPassword: 'NewBobPass1234' });
    expect(res.status).toBe(200);
    expect(row('SELECT must_change_password FROM users WHERE id = ?', u.id).must_change_password).toBe(1);

    // bob can log in with new password.
    const login = await client().post('/api/auth/login').send({ username: 'bob', password: 'NewBobPass1234' });
    expect(login.status).toBe(200);
  });

  test('rejects reset of AD user', async () => {
    const { db } = await import('../src/db/index.js');
    const info = db.prepare(`INSERT INTO users (username, source, role) VALUES (?, 'ad', 'submitter')`).run('aduser');
    const a = await adminAgent();
    const res = await a.post(`/api/users/${Number(info.lastInsertRowid)}/reset-password`).send({ newPassword: 'WhateverPass123' });
    expect(res.status).toBe(400);
  });

  test('rejects weak new password', async () => {
    const u = createUser({ username: 'bob' });
    const a = await adminAgent();
    const res = await a.post(`/api/users/${u.id}/reset-password`).send({ newPassword: 'short' });
    expect(res.status).toBe(400);
  });
});
