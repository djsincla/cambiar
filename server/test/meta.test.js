import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, client } from './helpers.js';

describe('Public meta endpoints', () => {
  test('GET /api/health returns ok + version + checks shape', async () => {
    const res = await client().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body.checks.db.ok).toBe(true);
    // Each scheduler reports {enabled, lastTickAt}; lastTickAt is null until fired.
    for (const name of ['digest', 'recurring', 'email', 'alerts', 'gcal']) {
      expect(res.body.checks.schedulers[name]).toMatchObject({ enabled: expect.any(Boolean) });
      expect(res.body.checks.schedulers[name]).toHaveProperty('lastTickAt');
    }
  });

  test('GET /api returns the project metadata', async () => {
    const res = await client().get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('cambiar.world');
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body.docs).toMatch(/^https:\/\//);
    expect(res.body.source).toMatch(/^https:\/\/github\.com\//);
    expect(res.body.issues).toMatch(/^https:\/\/github\.com\//);
  });
});

describe('GET /api/metrics (admin-only Prometheus exposition)', () => {
  beforeEach(resetDb);

  test('non-admin gets 403', async () => {
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');
    const res = await bob.get('/api/metrics');
    expect(res.status).toBe(403);
  });

  test('unauthenticated gets 401', async () => {
    const res = await client().get('/api/metrics');
    expect(res.status).toBe(401);
  });

  test('admin gets text/plain Prometheus output with the expected metric families', async () => {
    const a = await agentFor('admin', 'admin');
    await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });

    const res = await a.get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-type']).toMatch(/version=0\.0\.4/);

    const body = res.text;
    // HELP / TYPE lines + at least one sample for each family.
    for (const fam of [
      'cambiar_users_total',
      'cambiar_locked_users_total',
      'cambiar_changes_total',
      'cambiar_active_alerts_total',
      'cambiar_login_attempts_recent_total',
      'cambiar_scheduler_last_tick_age_seconds',
    ]) {
      expect(body).toContain(`# HELP ${fam}`);
      expect(body).toContain(`# TYPE ${fam}`);
    }
    // Admin user exists and is active → there's a row in cambiar_users_total.
    expect(body).toMatch(/cambiar_users_total\{role="admin",active="true"\} \d+/);
    // Scheduler ticks default to -1 (never fired since process start).
    expect(body).toMatch(/cambiar_scheduler_last_tick_age_seconds\{name="digest"\} -?\d+/);
  });

  test('login attempts after a failed login show up in the recent-login family', async () => {
    await client().post('/api/auth/login').send({ username: 'nobody', password: 'wrong' });

    const a = await agentFor('admin', 'admin');
    await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
    const res = await a.get('/api/metrics');
    expect(res.text).toMatch(/cambiar_login_attempts_recent_total\{outcome="invalid_credentials"\} \d+/);
  });
});
