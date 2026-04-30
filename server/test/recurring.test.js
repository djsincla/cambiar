import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, row, rows } from './helpers.js';
import { spawnChildFromParent, getRecurringParent } from '../src/services/recurringChanges.js';
import { db } from '../src/db/index.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

async function setupChange(agent, overrides = {}) {
  const r = await agent.post('/api/changes').send({
    typeKey: 'server_reboot',
    title: 'Monthly patch window',
    fields: REBOOT_FIELDS,
    plannedDurationMinutes: 60,
    ...overrides,
  });
  return r.body.change.id;
}

describe('POST /api/changes/:id/recurrence', () => {
  beforeEach(resetDb);

  test('admin sets recurrence; columns reflect; is_recurring_parent flips to 1', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);

    const res = await a.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 2 * * 2', // Tuesdays at 02:00
      timezone: 'America/Los_Angeles',
      leadMinutes: 60,
      autoSubmit: true,
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.recurring).toMatchObject({
      cronExpression: '0 2 * * 2',
      timezone: 'America/Los_Angeles',
      leadMinutes: 60,
      autoSubmit: true,
      enabled: true,
    });

    const stored = row('SELECT * FROM changes WHERE id = ?', id);
    expect(stored.is_recurring_parent).toBe(1);
    expect(stored.recurrence_cron).toBe('0 2 * * 2');
  });

  test('rejects an invalid cron expression', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    const res = await a.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: 'definitely not cron',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid cron/i);
  });

  test('non-owner non-admin gets 403', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    createUser({ username: 'eve', password: 'EvePass12345', role: 'submitter' });
    const eve = await agentFor('eve', 'EvePass12345');
    const res = await eve.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 0 * * *',
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/changes/:id/recurrence', () => {
  beforeEach(resetDb);

  test('clears the recurrence config; existing children are not deleted', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    await a.post(`/api/changes/${id}/recurrence`).send({ cronExpression: '0 0 * * *' });

    // Spawn a child manually so we can verify it survives the clear.
    const spawn = await a.post(`/api/changes/${id}/spawn-now`);
    expect(spawn.status).toBe(200);
    const childId = spawn.body.childId;

    const del = await a.delete(`/api/changes/${id}/recurrence`);
    expect(del.status).toBe(200);

    const after = row('SELECT * FROM changes WHERE id = ?', id);
    expect(after.is_recurring_parent).toBe(0);
    expect(after.recurrence_cron).toBeNull();

    // Child still exists with parent_change_id pointing back.
    const child = row('SELECT id, parent_change_id FROM changes WHERE id = ?', childId);
    expect(child).toBeDefined();
    expect(child.parent_change_id).toBe(id);
  });
});

describe('POST /api/changes/:id/spawn-now', () => {
  beforeEach(resetDb);

  test('child copies blueprint, sets parent_change_id, scheduled_at = now + leadMinutes', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    await a.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 0 * * *', leadMinutes: 30, autoSubmit: false,
    });

    const before = Date.now();
    const res = await a.post(`/api/changes/${id}/spawn-now`);
    expect(res.status).toBe(200);
    const childId = res.body.childId;
    expect(res.body.status).toBe('draft');

    const child = row('SELECT * FROM changes WHERE id = ?', childId);
    expect(child.parent_change_id).toBe(id);
    expect(child.type_key).toBe('server_reboot');
    expect(child.title).toBe('Monthly patch window');
    expect(child.planned_duration_minutes).toBe(60);
    expect(JSON.parse(child.fields_json)).toMatchObject(REBOOT_FIELDS);

    // scheduled_at ~ now + 30 minutes (allow 60s slop for test execution).
    const schedMs = Date.parse(child.scheduled_at);
    expect(schedMs).toBeGreaterThanOrEqual(before + 30 * 60_000 - 60_000);
    expect(schedMs).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 60_000);

    // Audit row tagged with source.
    const audit = row(`SELECT details FROM audit_log WHERE change_id = ? AND action = 'create'`, childId);
    const details = JSON.parse(audit.details);
    expect(details.source).toBe('recurring');
    expect(details.parentChangeId).toBe(id);
  });

  test('autoSubmit=true takes child to submitted', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    await a.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 0 * * *', autoSubmit: true,
    });
    const res = await a.post(`/api/changes/${id}/spawn-now`);
    expect(res.body.status).toBe('submitted');
  });

  test('autoSubmit=true with auto-approve type takes child to approved', async () => {
    const a = await adminAgent();
    // Mark server_reboot as auto-approve for this test.
    db.prepare("UPDATE change_types SET auto_approve = 1 WHERE key = 'server_reboot'").run();

    const id = await setupChange(a);
    await a.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 0 * * *', autoSubmit: true,
    });
    const res = await a.post(`/api/changes/${id}/spawn-now`);
    expect(res.body.status).toBe('approved');

    const child = row('SELECT status FROM changes WHERE id = ?', res.body.childId);
    expect(child.status).toBe('approved');
  });

  test('autoSubmit blocked when required fields are missing — child stays draft with audit note', async () => {
    const a = await adminAgent();
    // Create a parent missing a required field.
    const r = await a.post('/api/changes').send({
      typeKey: 'server_reboot',
      title: 'Incomplete',
      fields: { host: 'only-host' }, // reason + expected_downtime_minutes missing
    });
    const id = r.body.change.id;
    await a.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 0 * * *', autoSubmit: true,
    });
    const res = await a.post(`/api/changes/${id}/spawn-now`);
    expect(res.body.status).toBe('draft');
    expect(res.body.autoSubmitBlocked).toMatch(/required/i);
  });

  test('non-owner non-admin cannot spawn manually', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    await a.post(`/api/changes/${id}/recurrence`).send({ cronExpression: '0 0 * * *' });

    createUser({ username: 'eve', password: 'EvePass12345' });
    const eve = await agentFor('eve', 'EvePass12345');
    const res = await eve.post(`/api/changes/${id}/spawn-now`);
    expect(res.status).toBe(403);
  });

  test('spawn-now on a non-parent change returns 404', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    const res = await a.post(`/api/changes/${id}/spawn-now`);
    expect(res.status).toBe(404);
  });
});

describe('Default list excludes recurring parents', () => {
  beforeEach(resetDb);

  test('GET /api/changes returns only non-parents by default', async () => {
    const a = await adminAgent();
    const parentId = await setupChange(a, { title: 'parent' });
    const normalId = await setupChange(a, { title: 'normal' });
    await a.post(`/api/changes/${parentId}/recurrence`).send({ cronExpression: '0 0 * * *' });

    const res = await a.get('/api/changes');
    const ids = res.body.changes.map(c => c.id);
    expect(ids).toContain(normalId);
    expect(ids).not.toContain(parentId);
  });

  test('GET /api/changes?recurring=parents returns the parents view', async () => {
    const a = await adminAgent();
    const parentId = await setupChange(a, { title: 'p' });
    await a.post(`/api/changes/${parentId}/recurrence`).send({
      cronExpression: '0 9 * * 1-5', timezone: 'UTC',
    });
    const res = await a.get('/api/changes?recurring=parents');
    expect(res.body.recurringParents).toHaveLength(1);
    expect(res.body.recurringParents[0]).toMatchObject({
      id: parentId, recurrenceCron: '0 9 * * 1-5',
    });
  });

  test('?includeRecurringParents=true brings them back into the default list', async () => {
    const a = await adminAgent();
    const parentId = await setupChange(a);
    await a.post(`/api/changes/${parentId}/recurrence`).send({ cronExpression: '0 0 * * *' });

    const res = await a.get('/api/changes?includeRecurringParents=true');
    expect(res.body.changes.map(c => c.id)).toContain(parentId);
  });
});

describe('GET /api/changes/:id payload — parent + recurring relationships', () => {
  beforeEach(resetDb);

  test('on a parent: returns recurring config + recentChildren list', async () => {
    const a = await adminAgent();
    const parentId = await setupChange(a);
    await a.post(`/api/changes/${parentId}/recurrence`).send({
      cronExpression: '0 0 * * *', timezone: 'UTC', leadMinutes: 0, autoSubmit: false,
    });
    await a.post(`/api/changes/${parentId}/spawn-now`);

    const res = await a.get(`/api/changes/${parentId}`);
    expect(res.body.recurring).toMatchObject({
      cronExpression: '0 0 * * *', enabled: true,
    });
    expect(res.body.recurring.recentChildren).toHaveLength(1);
    expect(res.body.parent).toBeNull();
  });

  test('on a child: returns parent reference', async () => {
    const a = await adminAgent();
    const parentId = await setupChange(a);
    await a.post(`/api/changes/${parentId}/recurrence`).send({
      cronExpression: '0 0 * * *', autoSubmit: false,
    });
    const spawn = await a.post(`/api/changes/${parentId}/spawn-now`);
    const childId = spawn.body.childId;

    const res = await a.get(`/api/changes/${childId}`);
    expect(res.body.parent).toMatchObject({ id: parentId, title: 'Monthly patch window' });
    expect(res.body.recurring).toBeNull();
  });
});

describe('spawnChildFromParent service helper directly', () => {
  beforeEach(resetDb);

  test('uses the parent submitter_id on the child, not the caller', async () => {
    const a = await adminAgent();
    const id = await setupChange(a);
    await a.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 0 * * *', autoSubmit: false,
    });
    const parent = getRecurringParent(id);
    const r = await spawnChildFromParent(parent);
    const child = row('SELECT submitter_id FROM changes WHERE id = ?', r.childId);
    expect(child.submitter_id).toBe(parent.submitterId);
  });
});
