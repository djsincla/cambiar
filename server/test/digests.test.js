import { describe, test, expect, beforeEach, vi } from 'vitest';
import { resetDb, createUser, agentFor, client, row } from './helpers.js';
import { db } from '../src/db/index.js';
import * as email from '../src/notifications/email.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('POST /api/digests', () => {
  beforeEach(resetDb);

  test('admin creates a schedule with a valid cron and recipients', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/digests').send({
      name: 'Daily 6pm',
      cronExpression: '0 18 * * *',
      timezone: 'America/Los_Angeles',
      lookaheadDays: 7,
      statusFilter: ['approved', 'implemented'],
      recipientEmails: ['ops@example.com'],
    });
    expect(res.status).toBe(201);
    expect(res.body.schedule).toMatchObject({
      name: 'Daily 6pm',
      cronExpression: '0 18 * * *',
      timezone: 'America/Los_Angeles',
      lookaheadDays: 7,
      statusFilter: ['approved', 'implemented'],
      recipientEmails: ['ops@example.com'],
      enabled: true,
    });
  });

  test('rejects an invalid cron expression', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/digests').send({
      name: 'Bad', cronExpression: 'definitely not cron',
      recipientEmails: ['ops@example.com'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid cron/i);
  });

  test('requires at least one recipient', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/digests').send({
      name: 'No recipients', cronExpression: '0 9 * * *',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one recipient/i);
  });

  test('rejects unknown statuses in filter', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/digests').send({
      name: 'X', cronExpression: '0 9 * * *',
      statusFilter: ['nonexistent_status'],
      recipientEmails: ['ops@example.com'],
    });
    expect(res.status).toBe(400);
  });

  test('rejects malformed email in free-form recipients', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/digests').send({
      name: 'X', cronExpression: '0 9 * * *',
      recipientEmails: ['not-an-email'],
    });
    expect(res.status).toBe(400);
  });

  test('non-admin cannot create digests', async () => {
    createUser({ username: 'bob', password: 'BobPass1234' });
    const a = await agentFor('bob', 'BobPass1234');
    const res = await a.post('/api/digests').send({
      name: 'X', cronExpression: '0 9 * * *', recipientEmails: ['ops@example.com'],
    });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/digests/:id', () => {
  beforeEach(resetDb);

  test('partial update works and persists', async () => {
    const a = await adminAgent();
    const c = await a.post('/api/digests').send({
      name: 'Daily', cronExpression: '0 18 * * *',
      recipientEmails: ['ops@example.com'],
    });
    const res = await a.patch(`/api/digests/${c.body.schedule.id}`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.schedule.enabled).toBe(false);
    expect(res.body.schedule.cronExpression).toBe('0 18 * * *');
  });

  test('strict mode rejects unknown fields', async () => {
    const a = await adminAgent();
    const c = await a.post('/api/digests').send({
      name: 'Daily', cronExpression: '0 18 * * *',
      recipientEmails: ['ops@example.com'],
    });
    const res = await a.patch(`/api/digests/${c.body.schedule.id}`).send({ secretBackdoor: 1 });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/digests/:id', () => {
  beforeEach(resetDb);

  test('admin can delete', async () => {
    const a = await adminAgent();
    const c = await a.post('/api/digests').send({
      name: 'Daily', cronExpression: '0 18 * * *', recipientEmails: ['ops@example.com'],
    });
    const res = await a.delete(`/api/digests/${c.body.schedule.id}`);
    expect(res.status).toBe(200);
    expect(row('SELECT * FROM digest_schedules WHERE id = ?', c.body.schedule.id)).toBeUndefined();
  });
});

describe('Digest renderer + run-now', () => {
  beforeEach(resetDb);

  test('groups changes by day, includes only those in the lookahead window', async () => {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobPass1234', email: 'bob@example.com' });
    const bob = await agentFor('bob', 'BobPass1234');

    // Schedule one change inside the window, one outside.
    const inside = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Soon reboot',
      fields: REBOOT_FIELDS,
      scheduledAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    });
    const outside = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Far reboot',
      fields: REBOOT_FIELDS,
      scheduledAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    await bob.post(`/api/changes/${inside.body.change.id}/submit`);
    await bob.post(`/api/changes/${outside.body.change.id}/submit`);

    const schedule = (await a.post('/api/digests').send({
      name: 'Weekly', cronExpression: '0 9 * * 1',
      lookaheadDays: 7,
      statusFilter: ['submitted', 'approved'],
      recipientEmails: ['ops@example.com'],
    })).body.schedule;

    const sendEmail = vi.spyOn(email, 'sendEmail').mockResolvedValue();
    vi.spyOn(email, 'emailEnabled').mockReturnValue(true);

    const res = await a.post(`/api/digests/${schedule.id}/run-now`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.changes).toBe(1); // only the inside one
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toEqual(['ops@example.com']);
    expect(sendEmail.mock.calls[0][0].subject).toMatch(/Weekly/);
    expect(sendEmail.mock.calls[0][0].text).toContain('Soon reboot');
    expect(sendEmail.mock.calls[0][0].text).not.toContain('Far reboot');
  });

  test('resolves user-id recipients to their emails', async () => {
    const a = await adminAgent();
    const u = createUser({ username: 'alice', password: 'AlicePass1234', email: 'alice@example.com' });

    const schedule = (await a.post('/api/digests').send({
      name: 'Daily', cronExpression: '0 9 * * *',
      lookaheadDays: 7,
      recipientUserIds: [u.id],
    })).body.schedule;

    const sendEmail = vi.spyOn(email, 'sendEmail').mockResolvedValue();
    vi.spyOn(email, 'emailEnabled').mockReturnValue(true);

    await a.post(`/api/digests/${schedule.id}/run-now`);
    expect(sendEmail).toHaveBeenCalled();
    expect(sendEmail.mock.calls[0][0].to).toContain('alice@example.com');
  });

  test('reports error when no recipient emails resolve', async () => {
    const a = await adminAgent();
    const u = createUser({ username: 'noemail', password: 'NoEmailPass1' }); // no email

    const schedule = (await a.post('/api/digests').send({
      name: 'Empty', cronExpression: '0 9 * * *',
      recipientUserIds: [u.id],
    })).body.schedule;

    vi.spyOn(email, 'emailEnabled').mockReturnValue(true);
    const res = await a.post(`/api/digests/${schedule.id}/run-now`);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no recipient emails/i);
    // last_error was recorded.
    const after = row('SELECT last_error FROM digest_schedules WHERE id = ?', schedule.id);
    expect(after.last_error).toMatch(/no recipient emails/i);
  });

  test('reports error when email channel is disabled', async () => {
    const a = await adminAgent();
    const schedule = (await a.post('/api/digests').send({
      name: 'X', cronExpression: '0 9 * * *',
      recipientEmails: ['ops@example.com'],
    })).body.schedule;
    vi.spyOn(email, 'emailEnabled').mockReturnValue(false);
    const res = await a.post(`/api/digests/${schedule.id}/run-now`);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/email channel is disabled/);
  });

  test('records last_run_at and last_sent_at on success', async () => {
    const a = await adminAgent();
    const schedule = (await a.post('/api/digests').send({
      name: 'X', cronExpression: '0 9 * * *',
      recipientEmails: ['ops@example.com'],
    })).body.schedule;
    vi.spyOn(email, 'sendEmail').mockResolvedValue();
    vi.spyOn(email, 'emailEnabled').mockReturnValue(true);
    await a.post(`/api/digests/${schedule.id}/run-now`);
    const after = row('SELECT last_run_at, last_sent_at, last_error FROM digest_schedules WHERE id = ?', schedule.id);
    expect(after.last_run_at).toBeTruthy();
    expect(after.last_sent_at).toBeTruthy();
    expect(after.last_error).toBeNull();
  });
});

describe('GET /api/changes upcoming filter', () => {
  beforeEach(resetDb);

  test('scheduledFrom + scheduledTo filters and sorts ASC', async () => {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');

    const mkChange = async (offsetDays, title) => {
      const r = await bob.post('/api/changes').send({
        typeKey: 'server_reboot', title, fields: REBOOT_FIELDS,
        scheduledAt: new Date(Date.now() + offsetDays * 24 * 3600 * 1000).toISOString(),
      });
      return r.body.change.id;
    };
    const c1 = await mkChange(2, 'Inside');
    const c2 = await mkChange(5, 'Inside 2');
    await mkChange(40, 'Outside');

    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const res = await a.get(`/api/changes?scheduledFrom=${encodeURIComponent(from)}&scheduledTo=${encodeURIComponent(to)}`);
    expect(res.body.changes.map(c => c.id)).toEqual([c1, c2]);
  });
});
