import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, client, row } from './helpers.js';
import { db } from '../src/db/index.js';
import { resetUser, generatePassword } from '../src/cli/reset-admin.js';

describe('resetUser (CLI helper)', () => {
  beforeEach(resetDb);

  test('resets an existing admin password and forces change on next login', async () => {
    const r = resetUser({ username: 'admin', password: 'NewSecurePw1234' });
    expect(r.action).toBe('reset');
    expect(r.generated).toBe(false);

    const stored = row('SELECT * FROM users WHERE username = ?', 'admin');
    expect(stored.must_change_password).toBe(1);
    expect(stored.active).toBe(1);

    // The new password works at the API.
    const ok = await client().post('/api/auth/login').send({
      username: 'admin', password: 'NewSecurePw1234',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mustChangePassword).toBe(true);

    // The old password ("admin", from resetDb bootstrap) no longer works.
    const stale = await client().post('/api/auth/login').send({ username: 'admin', password: 'admin' });
    expect(stale.status).toBe(401);
  });

  test('reactivates a disabled admin', () => {
    db.prepare('UPDATE users SET active = 0 WHERE username = ?').run('admin');
    resetUser({ username: 'admin', password: 'StrongPwd12345' });
    expect(row('SELECT active FROM users WHERE username = ?', 'admin').active).toBe(1);
  });

  test('creates the user as admin if they do not exist', () => {
    const r = resetUser({ username: 'rescue', password: 'StrongPwd12345' });
    expect(r.action).toBe('created');

    const u = row('SELECT * FROM users WHERE username = ?', 'rescue');
    expect(u).toBeDefined();
    expect(u.role).toBe('admin');
    expect(u.source).toBe('local');
    expect(u.must_change_password).toBe(1);
    expect(u.active).toBe(1);
  });

  test('preserves an existing user’s role (does NOT silently promote)', () => {
    createUser({ username: 'bob', role: 'submitter', password: 'BobOldPw12345' });
    resetUser({ username: 'bob', password: 'BobNewPw12345' });
    expect(row('SELECT role FROM users WHERE username = ?', 'bob').role).toBe('submitter');
  });

  test('refuses to reset AD-sourced users', () => {
    db.prepare(`INSERT INTO users (username, source, role) VALUES ('aliceAD', 'ad', 'submitter')`).run();
    expect(() => resetUser({ username: 'aliceAD', password: 'whatever12345' }))
      .toThrow(/AD-sourced/);
    // The AD user record was not modified.
    expect(row('SELECT password_hash FROM users WHERE username = ?', 'aliceAD').password_hash).toBeNull();
  });

  test('generates a strong password when none is provided', () => {
    const r = resetUser({ username: 'admin' });
    expect(r.generated).toBe(true);
    expect(r.password.length).toBeGreaterThanOrEqual(20);
    expect(/[A-Z]/.test(r.password)).toBe(true);
    expect(/[a-z]/.test(r.password)).toBe(true);
    expect(/[0-9]/.test(r.password)).toBe(true);
  });

  test('rescue scenario: every admin demoted, then reset-admin restores access', async () => {
    // Simulate a "no admins left" scenario by demoting the bootstrap admin.
    db.prepare(`UPDATE users SET role = 'submitter' WHERE username = 'admin'`).run();

    // Create fresh admin via CLI.
    const r = resetUser({ username: 'rescue', password: 'RescuePwd12345' });
    expect(r.action).toBe('created');

    // Log in as rescue, change password, hit a protected admin endpoint.
    const login = await client().post('/api/auth/login').send({
      username: 'rescue', password: 'RescuePwd12345',
    });
    expect(login.status).toBe(200);

    // Use the cookie from login.
    const agent = (await import('supertest')).default.agent((await import('./helpers.js')).getApp());
    const a = await agent.post('/api/auth/login').send({ username: 'rescue', password: 'RescuePwd12345' });
    expect(a.status).toBe(200);

    // Forced password change blocks /api/users until completed.
    const blocked = await agent.get('/api/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Change password, then admin endpoints work.
    const change = await agent.post('/api/auth/change-password').send({
      currentPassword: 'RescuePwd12345', newPassword: 'RescueNewPw12345',
    });
    expect(change.status).toBe(200);
    const userList = await agent.get('/api/users');
    expect(userList.status).toBe(200);
  });
});

describe('generatePassword', () => {
  test('always meets complexity rules over many iterations', () => {
    for (let i = 0; i < 100; i++) {
      const pw = generatePassword();
      expect(pw.length).toBeGreaterThanOrEqual(20);
      expect(/[A-Z]/.test(pw)).toBe(true);
      expect(/[a-z]/.test(pw)).toBe(true);
      expect(/[0-9]/.test(pw)).toBe(true);
    }
  });

  test('avoids visually ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword();
      // No 0/O/o/1/I/l confusion in the alphabet we use.
      expect(/[0OoIl1]/.test(pw)).toBe(false);
    }
  });
});
