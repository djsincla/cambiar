// Operational alerts: approval-SLA breach + recurring-drift detection.
//
// Tests run the check function with a controlled `now` so we don't have to
// fast-forward real wall-clock time. Email side-effects are not asserted —
// the email transport is disabled in tests by default.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { resetDb, createUser, agentFor, client, row, rows } from './helpers.js';
import { runAlertChecks, listAlerts, alertsConfig } from '../src/services/alerts.js';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function ctx() {
  resetDb();
  const admin = await agentFor('admin', 'admin');
  await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  const bob = createUser({ username: 'bob', password: 'BobPass1234', role: 'submitter' });
  return { admin, bob: { ...bob, agent: await agentFor('bob', 'BobPass1234') } };
}

async function submitChange(submitter, opts = {}) {
  const create = await submitter.post('/api/changes').send({
    typeKey: 'server_reboot',
    title: opts.title ?? 'sla-test',
    fields: REBOOT_FIELDS,
    plannedDurationMinutes: 30,
  });
  const id = create.body.change.id;
  await submitter.post(`/api/changes/${id}/submit`);
  return id;
}

describe('approval SLA alerts', () => {
  test('fires when a change has been submitted past the SLA threshold', async () => {
    const { bob } = await ctx();
    const id = await submitChange(bob.agent, { title: 'old-pending' });
    // Backdate submitted_at to two days ago so the default 24h SLA triggers.
    db.prepare(`UPDATE changes SET submitted_at = datetime('now', '-2 days') WHERE id = ?`).run(id);

    const r = await runAlertChecks();
    expect(r.fired.map(x => x.subjectChangeId)).toContain(id);

    const open = listAlerts({ status: 'active' });
    const own = open.find(a => a.subjectChangeId === id && a.kind === 'approval_sla');
    expect(own).toBeDefined();
    expect(own.details.slaMinutes).toBe(alertsConfig().approvalSlaMinutes);
  });

  test('does NOT fire when the change has been submitted within the threshold', async () => {
    const { bob } = await ctx();
    const id = await submitChange(bob.agent, { title: 'fresh-pending' });
    // Just now — SLA isn't tripped yet.
    db.prepare(`UPDATE changes SET submitted_at = datetime('now', '-1 minutes') WHERE id = ?`).run(id);
    const r = await runAlertChecks();
    expect(r.fired.find(x => x.subjectChangeId === id)).toBeUndefined();
    const open = listAlerts({ status: 'active' });
    expect(open.find(a => a.subjectChangeId === id)).toBeUndefined();
  });

  test('idempotent — re-running the check while the condition persists does not re-fire', async () => {
    const { bob } = await ctx();
    const id = await submitChange(bob.agent);
    db.prepare(`UPDATE changes SET submitted_at = datetime('now', '-2 days') WHERE id = ?`).run(id);

    const a = await runAlertChecks();
    expect(a.fired.length).toBe(1);
    const b = await runAlertChecks();
    expect(b.fired.length).toBe(0);
    // Still only one open alert for this change.
    const open = listAlerts({ status: 'active' }).filter(x => x.subjectChangeId === id && x.kind === 'approval_sla');
    expect(open.length).toBe(1);
  });

  test('resolves when the change moves out of submitted (e.g. is approved)', async () => {
    const { admin, bob } = await ctx();
    const id = await submitChange(bob.agent);
    db.prepare(`UPDATE changes SET submitted_at = datetime('now', '-2 days') WHERE id = ?`).run(id);
    await runAlertChecks();
    expect(listAlerts({ status: 'active' }).find(x => x.subjectChangeId === id)).toBeDefined();

    await admin.post(`/api/changes/${id}/approve`);
    const r = await runAlertChecks();
    expect(r.resolved.map(x => x.subjectChangeId)).toContain(id);
    expect(listAlerts({ status: 'active' }).find(x => x.subjectChangeId === id)).toBeUndefined();
  });
});

describe('recurring drift alerts', () => {
  test('fires when a recurring parent\'s last fire is older than the last expected fire', async () => {
    const { bob } = await ctx();
    const create = await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'daily-2am', fields: REBOOT_FIELDS, plannedDurationMinutes: 30,
    });
    const id = create.body.change.id;
    // Make it a recurring parent with a daily 2am cron, last fire was 3 days ago.
    await bob.agent.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 2 * * *', timezone: 'UTC', leadMinutes: 0, autoSubmit: true, enabled: true,
    });
    db.prepare(`UPDATE changes SET recurrence_last_fired_at = datetime('now', '-3 days') WHERE id = ?`).run(id);

    const r = await runAlertChecks();
    expect(r.fired.find(x => x.kind === 'recurring_drift' && x.subjectChangeId === id)).toBeDefined();

    const open = listAlerts({ status: 'active' });
    const drift = open.find(a => a.kind === 'recurring_drift' && a.subjectChangeId === id);
    expect(drift).toBeDefined();
    expect(drift.details.cron).toBe('0 2 * * *');
  });

  test('does NOT fire when the parent has fired within tolerance of the last expected time', async () => {
    const { bob } = await ctx();
    const create = await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'every-5-min', fields: REBOOT_FIELDS, plannedDurationMinutes: 5,
    });
    const id = create.body.change.id;
    await bob.agent.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '*/5 * * * *', timezone: 'UTC', leadMinutes: 0, autoSubmit: true, enabled: true,
    });
    // Set last_fired to right now — well within tolerance.
    db.prepare(`UPDATE changes SET recurrence_last_fired_at = datetime('now') WHERE id = ?`).run(id);
    const r = await runAlertChecks();
    expect(r.fired.find(x => x.kind === 'recurring_drift' && x.subjectChangeId === id)).toBeUndefined();
  });

  test('drift alert resolves once the parent fires again', async () => {
    const { bob } = await ctx();
    const create = await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'daily', fields: REBOOT_FIELDS, plannedDurationMinutes: 5,
    });
    const id = create.body.change.id;
    await bob.agent.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 2 * * *', timezone: 'UTC', leadMinutes: 0, autoSubmit: true, enabled: true,
    });
    // Drift first.
    db.prepare(`UPDATE changes SET recurrence_last_fired_at = datetime('now', '-3 days') WHERE id = ?`).run(id);
    await runAlertChecks();
    expect(listAlerts({ status: 'active' }).find(a => a.kind === 'recurring_drift' && a.subjectChangeId === id)).toBeDefined();

    // Caught up.
    db.prepare(`UPDATE changes SET recurrence_last_fired_at = datetime('now') WHERE id = ?`).run(id);
    const r = await runAlertChecks();
    expect(r.resolved.find(x => x.kind === 'recurring_drift' && x.subjectChangeId === id)).toBeDefined();
    expect(listAlerts({ status: 'active' }).find(a => a.kind === 'recurring_drift' && a.subjectChangeId === id)).toBeUndefined();
  });

  test('disabled recurring parents are not checked', async () => {
    const { bob } = await ctx();
    const create = await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'paused', fields: REBOOT_FIELDS, plannedDurationMinutes: 5,
    });
    const id = create.body.change.id;
    await bob.agent.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 2 * * *', timezone: 'UTC', leadMinutes: 0, autoSubmit: true, enabled: false,
    });
    db.prepare(`UPDATE changes SET recurrence_last_fired_at = datetime('now', '-30 days') WHERE id = ?`).run(id);
    const r = await runAlertChecks();
    expect(r.fired.find(x => x.kind === 'recurring_drift' && x.subjectChangeId === id)).toBeUndefined();
  });
});

describe('alerts API', () => {
  test('GET /api/alerts/count is available to any authed user', async () => {
    const { bob } = await ctx();
    const id = await submitChange(bob.agent);
    db.prepare(`UPDATE changes SET submitted_at = datetime('now', '-2 days') WHERE id = ?`).run(id);
    await runAlertChecks();
    const res = await bob.agent.get('/api/alerts/count');
    expect(res.status).toBe(200);
    expect(res.body.active).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/alerts requires admin', async () => {
    const { bob } = await ctx();
    expect((await bob.agent.get('/api/alerts')).status).toBe(403);
  });

  test('admin lists alerts and resolves one', async () => {
    const { admin, bob } = await ctx();
    const id = await submitChange(bob.agent);
    db.prepare(`UPDATE changes SET submitted_at = datetime('now', '-2 days') WHERE id = ?`).run(id);
    await runAlertChecks();

    const list = await admin.get('/api/alerts');
    expect(list.status).toBe(200);
    const a = list.body.alerts.find(x => x.subjectChangeId === id);
    expect(a).toBeDefined();

    const r = await admin.post(`/api/alerts/${a.id}/resolve`);
    expect(r.status).toBe(200);

    const after = (await admin.get('/api/alerts')).body.alerts;
    expect(after.find(x => x.id === a.id)).toBeUndefined();
  });

  test('POST /api/alerts/check-now runs the checks on demand', async () => {
    const { admin, bob } = await ctx();
    const id = await submitChange(bob.agent);
    db.prepare(`UPDATE changes SET submitted_at = datetime('now', '-2 days') WHERE id = ?`).run(id);
    const res = await admin.post('/api/alerts/check-now');
    expect(res.status).toBe(200);
    expect(res.body.fired.find(x => x.subjectChangeId === id)).toBeDefined();
  });
});
