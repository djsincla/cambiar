import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, row, rows } from './helpers.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('plannedDurationMinutes on create + patch', () => {
  beforeEach(resetDb);

  test('create accepts plannedDurationMinutes and returns it', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
      plannedDurationMinutes: 120,
    });
    expect(res.status).toBe(201);
    expect(res.body.change.plannedDurationMinutes).toBe(120);
  });

  test('PATCH on a draft updates plannedDurationMinutes', async () => {
    const a = await adminAgent();
    const c = await a.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
    });
    const patched = await a.patch(`/api/changes/${c.body.change.id}`).send({ plannedDurationMinutes: 90 });
    expect(patched.status).toBe(200);
    expect(patched.body.change.plannedDurationMinutes).toBe(90);
  });

  test('rejects negative or zero duration', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
      plannedDurationMinutes: 0,
    });
    expect(res.status).toBe(400);
  });

  test('rejects absurdly large duration (>30 days)', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
      plannedDurationMinutes: 60 * 24 * 31,
    });
    expect(res.status).toBe(400);
  });
});

describe('actualDurationMinutes on implement', () => {
  beforeEach(resetDb);

  async function createApprovedChange(a) {
    const c = await a.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Reboot', fields: REBOOT_FIELDS,
      plannedDurationMinutes: 60,
    });
    const cid = c.body.change.id;
    await a.post(`/api/changes/${cid}/submit`);
    // Need someone else to approve (admin can't approve own). Promote a quick second admin.
    createUser({ username: 'a2', password: 'A2Pass123456', role: 'admin' });
    const a2 = await agentFor('a2', 'A2Pass123456');
    await a2.post(`/api/changes/${cid}/approve`);
    return cid;
  }

  test('implement with actualDurationMinutes records on the change and audit', async () => {
    const a = await adminAgent();
    const cid = await createApprovedChange(a);
    const res = await a.post(`/api/changes/${cid}/implement`).send({ actualDurationMinutes: 75 });
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('implemented');
    expect(res.body.change.actualDurationMinutes).toBe(75);

    const audit = rows('SELECT action, details FROM audit_log WHERE change_id = ? ORDER BY id', cid);
    const impl = audit.find(a => a.action === 'implement');
    expect(JSON.parse(impl.details)).toEqual({ actualDurationMinutes: 75 });
  });

  test('implement without actualDurationMinutes leaves it null', async () => {
    const a = await adminAgent();
    const cid = await createApprovedChange(a);
    const res = await a.post(`/api/changes/${cid}/implement`);
    expect(res.body.change.actualDurationMinutes).toBeNull();
  });

  test('PATCH /actual-duration sets value on an implemented change', async () => {
    const a = await adminAgent();
    const cid = await createApprovedChange(a);
    await a.post(`/api/changes/${cid}/implement`);
    const res = await a.patch(`/api/changes/${cid}/actual-duration`).send({ actualDurationMinutes: 105 });
    expect(res.status).toBe(200);
    expect(res.body.change.actualDurationMinutes).toBe(105);
  });

  test('PATCH /actual-duration accepts null to clear', async () => {
    const a = await adminAgent();
    const cid = await createApprovedChange(a);
    await a.post(`/api/changes/${cid}/implement`).send({ actualDurationMinutes: 50 });
    const res = await a.patch(`/api/changes/${cid}/actual-duration`).send({ actualDurationMinutes: null });
    expect(res.status).toBe(200);
    expect(res.body.change.actualDurationMinutes).toBeNull();
  });

  test('PATCH /actual-duration works on closed changes too', async () => {
    const a = await adminAgent();
    const cid = await createApprovedChange(a);
    await a.post(`/api/changes/${cid}/implement`);
    await a.post(`/api/changes/${cid}/close`);
    const res = await a.patch(`/api/changes/${cid}/actual-duration`).send({ actualDurationMinutes: 90 });
    expect(res.status).toBe(200);
  });

  test('PATCH /actual-duration rejected on draft / submitted / approved', async () => {
    const a = await adminAgent();
    const c = await a.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
    });
    const res = await a.patch(`/api/changes/${c.body.change.id}/actual-duration`).send({ actualDurationMinutes: 30 });
    expect(res.status).toBe(409);
  });

  test('non-owner non-admin cannot set actual duration', async () => {
    const a = await adminAgent();
    createUser({ username: 'eve', password: 'EvePass123456', role: 'submitter' });
    const eve = await agentFor('eve', 'EvePass123456');
    const cid = await createApprovedChange(a);
    await a.post(`/api/changes/${cid}/implement`);
    const res = await eve.patch(`/api/changes/${cid}/actual-duration`).send({ actualDurationMinutes: 50 });
    expect(res.status).toBe(403);
  });
});
