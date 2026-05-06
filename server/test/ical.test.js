// iCal subscription feed: per-user token, public GET /ical/upcoming.ics,
// rotation, and content shape.

import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, client, row } from './helpers.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function ctx() {
  resetDb();
  const admin = await agentFor('admin', 'admin');
  await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  const bob = createUser({ username: 'bob', password: 'BobPass1234', role: 'submitter' });
  return {
    admin,
    bob: { ...bob, agent: await agentFor('bob', 'BobPass1234') },
  };
}

async function createScheduledChange(submitter, approver, { status = 'submitted', daysAhead = 2, title } = {}) {
  const scheduledAt = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
  const create = await submitter.post('/api/changes').send({
    typeKey: 'server_reboot',
    title: title ?? `ical-test ${Math.random().toString(36).slice(2, 6)}`,
    fields: REBOOT_FIELDS,
    scheduledAt,
    plannedDurationMinutes: 30,
  });
  const id = create.body.change.id;
  if (status === 'draft') return id;
  await submitter.post(`/api/changes/${id}/submit`);
  if (status === 'submitted') return id;
  if (approver) await approver.post(`/api/changes/${id}/approve`);
  if (status === 'approved') return id;
  await submitter.post(`/api/changes/${id}/start`);
  if (status === 'in_progress') return id;
  await submitter.post(`/api/changes/${id}/implement`).send({ actualDurationMinutes: 5 });
  if (status === 'implemented') return id;
  await submitter.post(`/api/changes/${id}/close`);
  return id;
}

describe('iCal token endpoints', () => {
  test('GET /api/auth/me/ical-token is created on first request and stable on second', async () => {
    const { bob } = await ctx();
    const a = await bob.agent.get('/api/auth/me/ical-token');
    expect(a.status).toBe(200);
    expect(a.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(a.body.url).toContain(`token=${encodeURIComponent(a.body.token)}`);
    const b = await bob.agent.get('/api/auth/me/ical-token');
    expect(b.body.token).toBe(a.body.token);
  });

  test('POST /api/auth/me/ical-token/rotate replaces the token', async () => {
    const { bob } = await ctx();
    const a = await bob.agent.get('/api/auth/me/ical-token');
    const r = await bob.agent.post('/api/auth/me/ical-token/rotate');
    expect(r.status).toBe(200);
    expect(r.body.token).not.toBe(a.body.token);
    // Old token should no longer authenticate.
    const c = client();
    const stale = await c.get(`/ical/upcoming.ics?token=${a.body.token}`);
    expect(stale.status).toBe(401);
    const fresh = await c.get(`/ical/upcoming.ics?token=${r.body.token}`);
    expect(fresh.status).toBe(200);
  });

  test('ical-token endpoints require auth', async () => {
    resetDb();
    const c = client();
    expect((await c.get('/api/auth/me/ical-token')).status).toBe(401);
    expect((await c.post('/api/auth/me/ical-token/rotate')).status).toBe(401);
  });
});

describe('GET /ical/upcoming.ics', () => {
  test('missing or wrong token → 401 plain text', async () => {
    resetDb();
    const c = client();
    const a = await c.get('/ical/upcoming.ics');
    expect(a.status).toBe(401);
    const b = await c.get('/ical/upcoming.ics?token=nope');
    expect(b.status).toBe(401);
  });

  test('valid token → text/calendar with VCALENDAR envelope', async () => {
    const { bob } = await ctx();
    const t = (await bob.agent.get('/api/auth/me/ical-token')).body.token;
    const res = await client().get(`/ical/upcoming.ics?token=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.text).toContain('BEGIN:VCALENDAR');
    expect(res.text).toContain('END:VCALENDAR');
    expect(res.text).toContain('PRODID:-//cambiar.world//EN');
  });

  test('feed includes scheduled submitted/approved/in_progress/implemented and excludes draft/closed/rejected', async () => {
    const { bob, admin } = await ctx();
    const submitted = await createScheduledChange(bob.agent, admin, { status: 'submitted', daysAhead: 1, title: 'see-me-submitted' });
    const approved = await createScheduledChange(bob.agent, admin, { status: 'approved', daysAhead: 2, title: 'see-me-approved' });
    const draft = await createScheduledChange(bob.agent, admin, { status: 'draft', daysAhead: 3, title: 'hide-draft' });
    const closed = await createScheduledChange(bob.agent, admin, { status: 'closed', daysAhead: 4, title: 'hide-closed' });

    const t = (await bob.agent.get('/api/auth/me/ical-token')).body.token;
    const body = (await client().get(`/ical/upcoming.ics?token=${t}`)).text;

    expect(body).toContain(`UID:cambiar-change-${submitted}@`);
    expect(body).toContain(`UID:cambiar-change-${approved}@`);
    expect(body).not.toContain(`UID:cambiar-change-${draft}@`);
    expect(body).not.toContain(`UID:cambiar-change-${closed}@`);

    // submitted → TENTATIVE; approved → CONFIRMED.
    const submittedBlock = extractEvent(body, submitted);
    const approvedBlock = extractEvent(body, approved);
    expect(submittedBlock).toContain('STATUS:TENTATIVE');
    expect(approvedBlock).toContain('STATUS:CONFIRMED');
  });

  test('event has DTSTART, DTEND derived from planned duration, SUMMARY with cambiar.world prefix, URL', async () => {
    const { bob, admin } = await ctx();
    const id = await createScheduledChange(bob.agent, admin, { status: 'approved', daysAhead: 1, title: 'shape-test' });
    const t = (await bob.agent.get('/api/auth/me/ical-token')).body.token;
    const body = (await client().get(`/ical/upcoming.ics?token=${t}`)).text;
    const ev = extractEvent(body, id);
    expect(ev).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ev).toMatch(/DTEND:\d{8}T\d{6}Z/);
    expect(ev).toContain(`SUMMARY:[cambiar.world #${id}] shape-test`);
    expect(ev).toMatch(/URL:\S*\/changes\/\d+/);
  });

  test('inactive user\'s token is refused', async () => {
    const { bob } = await ctx();
    const t = (await bob.agent.get('/api/auth/me/ical-token')).body.token;
    // Deactivate bob directly.
    const userId = row("SELECT id FROM users WHERE username = 'bob'").id;
    const { db } = await import('../src/db/index.js');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId);
    const res = await client().get(`/ical/upcoming.ics?token=${t}`);
    expect(res.status).toBe(401);
  });

  test('feed excludes recurring parents (they are generators, not events)', async () => {
    const { bob, admin } = await ctx();
    const id = await createScheduledChange(bob.agent, admin, { status: 'approved', daysAhead: 1, title: 'recurring-parent' });
    // Mark as recurring parent.
    await bob.agent.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 2 * * *', timezone: 'UTC', leadMinutes: 0, autoSubmit: true, enabled: true,
    });
    const t = (await bob.agent.get('/api/auth/me/ical-token')).body.token;
    const body = (await client().get(`/ical/upcoming.ics?token=${t}`)).text;
    expect(body).not.toContain(`UID:cambiar-change-${id}@`);
  });
});

function extractEvent(body, id) {
  // VEVENT blocks are CRLF-separated; pull the one matching the UID.
  const match = body.split(/BEGIN:VEVENT/).find(b => b.includes(`UID:cambiar-change-${id}@`));
  return match ?? '';
}
