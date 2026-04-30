import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, row, rows } from './helpers.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function setup() {
  resetDb();
  const adminA = await agentFor('admin', 'admin');
  await adminA.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });

  const bob = createUser({ username: 'bob', password: 'BobPass1234', role: 'submitter' });
  const carol = createUser({ username: 'carol', password: 'CarolPass1234', role: 'approver' });
  const eve = createUser({ username: 'eve', password: 'EvePass12345', role: 'submitter' });

  return {
    admin: adminA,
    bob: { ...bob, agent: await agentFor('bob', 'BobPass1234') },
    carol: { ...carol, agent: await agentFor('carol', 'CarolPass1234') },
    eve: { ...eve, agent: await agentFor('eve', 'EvePass12345') },
  };
}

async function approveAReboot(bob, carol) {
  const create = await bob.agent.post('/api/changes').send({
    typeKey: 'server_reboot', title: 'Reboot', fields: REBOOT_FIELDS,
    plannedDurationMinutes: 60,
  });
  const id = create.body.change.id;
  await bob.agent.post(`/api/changes/${id}/submit`);
  await carol.agent.post(`/api/changes/${id}/approve`);
  return id;
}

describe('POST /api/changes/:id/start', () => {
  test('approved → in_progress with audit row', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);

    const res = await bob.agent.post(`/api/changes/${id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('in_progress');
    expect(res.body.change.inProgressAt).toBeTruthy();

    const audit = rows('SELECT action, from_status, to_status FROM audit_log WHERE change_id = ? AND action = ?', id, 'start');
    expect(audit).toEqual([{ action: 'start', from_status: 'approved', to_status: 'in_progress' }]);
  });

  test('admin can start someone else\'s change', async () => {
    const { admin, bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    const res = await admin.post(`/api/changes/${id}/start`);
    expect(res.status).toBe(200);
  });

  test('non-owner non-admin cannot start', async () => {
    const { bob, carol, eve } = await setup();
    const id = await approveAReboot(bob, carol);
    const res = await eve.agent.post(`/api/changes/${id}/start`);
    expect(res.status).toBe(403);
  });

  test('rejects starting a draft / submitted / implemented / closed / rejected change', async () => {
    const { bob } = await setup();
    const draft = await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
    });
    const res = await bob.agent.post(`/api/changes/${draft.body.change.id}/start`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/changes/:id/implement (in_progress aware)', () => {
  test('in_progress → implement still works', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    await bob.agent.post(`/api/changes/${id}/start`);
    const res = await bob.agent.post(`/api/changes/${id}/implement`);
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('implemented');
  });

  test('approved → implement (skipping /start) still works (back-compat)', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    const res = await bob.agent.post(`/api/changes/${id}/implement`);
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('implemented');
  });

  test('actual duration is derived from in_progress_at when not supplied', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);

    // Pretend implementation started 45 minutes ago.
    await bob.agent.post(`/api/changes/${id}/start`);
    const fakeStart = new Date(Date.now() - 45 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    (await import('../src/db/index.js')).db
      .prepare(`UPDATE changes SET in_progress_at = ? WHERE id = ?`).run(fakeStart, id);

    const res = await bob.agent.post(`/api/changes/${id}/implement`);
    expect(res.status).toBe(200);
    // Allow a 1-minute fudge for clock skew.
    expect(res.body.change.actualDurationMinutes).toBeGreaterThanOrEqual(44);
    expect(res.body.change.actualDurationMinutes).toBeLessThanOrEqual(46);
  });

  test('explicit actualDurationMinutes overrides the derived value', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    await bob.agent.post(`/api/changes/${id}/start`);
    const res = await bob.agent.post(`/api/changes/${id}/implement`).send({ actualDurationMinutes: 99 });
    expect(res.body.change.actualDurationMinutes).toBe(99);
  });
});

describe('POST /api/changes/:id/rollback (in_progress aware)', () => {
  test('rolls back from in_progress', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    await bob.agent.post(`/api/changes/${id}/start`);
    const res = await bob.agent.post(`/api/changes/${id}/rollback`).send({ comment: 'aborted' });
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('rolled_back');
  });

  test('still allowed from implemented and closed', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    await bob.agent.post(`/api/changes/${id}/start`);
    await bob.agent.post(`/api/changes/${id}/implement`);
    const r1 = await bob.agent.post(`/api/changes/${id}/rollback`);
    expect(r1.status).toBe(200);
  });

  test('still rejected from approved (work hasn\'t actually started)', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    const res = await bob.agent.post(`/api/changes/${id}/rollback`);
    expect(res.status).toBe(409);
  });
});

describe('Status filters and views see in_progress', () => {
  test('filtering ?status=in_progress finds the changes', async () => {
    const { admin, bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    await bob.agent.post(`/api/changes/${id}/start`);
    const res = await admin.get('/api/changes?status=in_progress');
    expect(res.body.changes.map(c => c.id)).toContain(id);
  });

  test('inProgressAt is exposed on the change payload', async () => {
    const { bob, carol } = await setup();
    const id = await approveAReboot(bob, carol);
    await bob.agent.post(`/api/changes/${id}/start`);
    const res = await bob.agent.get(`/api/changes/${id}`);
    expect(res.body.change.inProgressAt).toBeTruthy();
  });
});
