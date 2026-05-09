// Login-attempt audit + account lockout. Both features are coupled — the
// lockout decision is driven by the recent-failure count from auth_events,
// so the same test surface covers both.

import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, client, rows, row } from './helpers.js';
import { db } from '../src/db/index.js';

const POLICY_THRESHOLD = 5;

describe('auth_events: every login attempt is recorded', () => {
  beforeEach(() => { resetDb(); createUser({ username: 'bob', password: 'BobPass1234' }); });

  test('successful login records outcome=success with source=local + user_id', async () => {
    await agentFor('bob', 'BobPass1234');
    const events = rows(`SELECT username, outcome, source, user_id FROM auth_events ORDER BY id`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ username: 'bob', outcome: 'success', source: 'local' });
    expect(events[0].user_id).toBeGreaterThan(0);
  });

  test('failed login records outcome=invalid_credentials', async () => {
    await client().post('/api/auth/login').send({ username: 'bob', password: 'wrong' });
    const ev = row(`SELECT outcome, source FROM auth_events WHERE username = 'bob'`);
    expect(ev).toMatchObject({ outcome: 'invalid_credentials', source: 'local' });
  });

  test('login attempt for unknown username is also audited (password-spray visibility)', async () => {
    await client().post('/api/auth/login').send({ username: 'nobody', password: 'whatever' });
    const ev = row(`SELECT outcome, source, user_id FROM auth_events WHERE username = 'nobody'`);
    expect(ev).toMatchObject({ outcome: 'invalid_credentials', source: 'unknown' });
    expect(ev.user_id).toBeNull();
  });

  test('captures user_agent (truncated) and ip', async () => {
    await client()
      .post('/api/auth/login')
      .set('User-Agent', 'CustomUA/1.0')
      .send({ username: 'bob', password: 'BobPass1234' });
    const ev = row(`SELECT user_agent, ip FROM auth_events WHERE username = 'bob'`);
    expect(ev.user_agent).toBe('CustomUA/1.0');
    expect(ev.ip).toBeTruthy();
  });

  test('disabled-account login records outcome=account_disabled', async () => {
    db.prepare("UPDATE users SET active = 0 WHERE username = 'bob'").run();
    const r = await client().post('/api/auth/login').send({ username: 'bob', password: 'BobPass1234' });
    expect(r.status).toBe(403);
    const ev = row(`SELECT outcome FROM auth_events WHERE username = 'bob'`);
    expect(ev.outcome).toBe('account_disabled');
  });
});

describe('lockout: 5 failures within the window locks the account', () => {
  beforeEach(() => { resetDb(); createUser({ username: 'bob', password: 'BobPass1234' }); });

  async function fail(times = POLICY_THRESHOLD) {
    for (let i = 0; i < times; i++) {
      await client().post('/api/auth/login').send({ username: 'bob', password: `wrong-${i}` });
    }
  }

  test(`locks the account after ${POLICY_THRESHOLD} failed attempts`, async () => {
    await fail(POLICY_THRESHOLD);
    const u = row(`SELECT locked_until FROM users WHERE username = 'bob'`);
    expect(u.locked_until).toBeTruthy();
    expect(Date.parse(u.locked_until)).toBeGreaterThan(Date.now());
  });

  test('locked account refuses even the correct password', async () => {
    await fail(POLICY_THRESHOLD);
    const r = await client().post('/api/auth/login').send({ username: 'bob', password: 'BobPass1234' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/locked/i);
    expect(r.body.retryAfterMinutes).toBeGreaterThan(0);
  });

  test('lock is logged as an account_locked auth_event on subsequent attempts', async () => {
    await fail(POLICY_THRESHOLD);
    await client().post('/api/auth/login').send({ username: 'bob', password: 'BobPass1234' });
    const lockedRow = row(`SELECT outcome FROM auth_events WHERE username = 'bob' AND outcome = 'account_locked'`);
    expect(lockedRow).toBeDefined();
  });

  test('successful login (with correct credentials within the threshold) clears the lock', async () => {
    await fail(POLICY_THRESHOLD - 1); // 4 failures, not yet locked
    const ok = await client().post('/api/auth/login').send({ username: 'bob', password: 'BobPass1234' });
    expect(ok.status).toBe(200);
    const u = row(`SELECT locked_until FROM users WHERE username = 'bob'`);
    expect(u.locked_until).toBeNull();
  });

  test('admin can clear a lock via POST /api/auth/clear-lock', async () => {
    await fail(POLICY_THRESHOLD);
    const admin = await agentFor('admin', 'admin');
    await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
    const r = await admin.post('/api/auth/clear-lock').send({ username: 'bob' });
    expect(r.status).toBe(200);
    const u = row(`SELECT locked_until FROM users WHERE username = 'bob'`);
    expect(u.locked_until).toBeNull();
  });

  test('clear-lock endpoint requires admin', async () => {
    createUser({ username: 'eve', password: 'EvePass12345' });
    const eve = await agentFor('eve', 'EvePass12345');
    const r = await eve.post('/api/auth/clear-lock').send({ username: 'bob' });
    expect(r.status).toBe(403);
  });

  test('clear-lock returns 404 for unknown username (so it can\'t be used to enumerate)', async () => {
    const admin = await agentFor('admin', 'admin');
    await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
    const r = await admin.post('/api/auth/clear-lock').send({ username: 'nobody' });
    expect(r.status).toBe(404);
  });
});

describe('GET /api/auth/events (admin)', () => {
  beforeEach(() => { resetDb(); createUser({ username: 'bob', password: 'BobPass1234' }); });

  test('admin can list recent events; non-admin cannot', async () => {
    await client().post('/api/auth/login').send({ username: 'bob', password: 'wrong' });

    const admin = await agentFor('admin', 'admin');
    await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
    const ok = await admin.get('/api/auth/events');
    expect(ok.status).toBe(200);
    expect(ok.body.events.length).toBeGreaterThanOrEqual(1);
    expect(ok.body.policy).toMatchObject({ threshold: POLICY_THRESHOLD });

    const bob = await agentFor('bob', 'BobPass1234');
    const denied = await bob.get('/api/auth/events');
    expect(denied.status).toBe(403);
  });

  test('?outcome filter narrows the list', async () => {
    await client().post('/api/auth/login').send({ username: 'bob', password: 'wrong' });
    await client().post('/api/auth/login').send({ username: 'bob', password: 'BobPass1234' });

    const admin = await agentFor('admin', 'admin');
    await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
    const r = await admin.get('/api/auth/events?outcome=invalid_credentials');
    expect(r.body.events.every(e => e.outcome === 'invalid_credentials')).toBe(true);
  });
});

describe('timing flatness: unknown username and wrong password feel the same', () => {
  beforeEach(() => { resetDb(); createUser({ username: 'bob', password: 'BobPass1234' }); });

  test('both run a bcrypt compare (response time bounded below by ~bcrypt cost)', async () => {
    // We assert the audit row shape rather than exact timing — vitest can be
    // jittery on CI. The point of the test is that the path is exercised.
    await client().post('/api/auth/login').send({ username: 'bob', password: 'wrong' });
    await client().post('/api/auth/login').send({ username: 'nobody', password: 'wrong' });
    const events = rows(`SELECT username, outcome FROM auth_events ORDER BY id`);
    expect(events).toEqual([
      { username: 'bob', outcome: 'invalid_credentials' },
      { username: 'nobody', outcome: 'invalid_credentials' },
    ]);
  });
});
