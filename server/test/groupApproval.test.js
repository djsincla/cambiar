import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, createGroup, addUserToGroup, agentFor, setApproverGroups } from './helpers.js';

async function setupFixtures({ approverGroups = [] } = {}) {
  resetDb();
  const adminA = await agentFor('admin', 'admin');
  await adminA.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });

  const bob = createUser({ username: 'bob', password: 'BobP1234567', role: 'submitter' });
  const carol = createUser({ username: 'carol', password: 'CarolP1234', role: 'submitter' });
  const dave = createUser({ username: 'dave', password: 'DaveP12345', role: 'submitter' });
  const eve = createUser({ username: 'eve', password: 'EveP123456', role: 'approver' });

  const groupIds = [];
  for (const groupName of approverGroups) {
    const g = createGroup({ name: groupName });
    groupIds.push(g.id);
  }

  return {
    admin: adminA,
    bob: { ...bob, agent: await agentFor('bob', 'BobP1234567') },
    carol: { ...carol, agent: await agentFor('carol', 'CarolP1234') },
    dave: { ...dave, agent: await agentFor('dave', 'DaveP12345') },
    eve: { ...eve, agent: await agentFor('eve', 'EveP123456') },
    groupIds,
  };
}

async function createServerReboot(agent) {
  const r = await agent.post('/api/changes').send({
    typeKey: 'server_reboot', title: 'reboot',
    fields: { host: 'h1', reason: 'r', expected_downtime_minutes: 5 },
  });
  return r.body.change.id;
}

describe('Group-based approval (any-one-group)', () => {
  test('a user IN the assigned group can approve', async () => {
    const { bob, carol, groupIds } = await setupFixtures({ approverGroups: ['Reviewers'] });
    addUserToGroup(carol.id, groupIds[0]);
    setApproverGroups('server_reboot', groupIds);

    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);

    const res = await carol.agent.post(`/api/changes/${id}/approve`).send({ comment: 'ok' });
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('approved');
  });

  test('a user NOT in any assigned group cannot approve (even with approver role)', async () => {
    const { bob, eve, groupIds } = await setupFixtures({ approverGroups: ['Reviewers'] });
    setApproverGroups('server_reboot', groupIds);
    // Eve has approver role but is NOT a member of "Reviewers".

    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);

    const res = await eve.agent.post(`/api/changes/${id}/approve`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member of any approver group/);
  });

  test('any-one-group: membership in EITHER assigned group is enough', async () => {
    const { bob, dave, groupIds } = await setupFixtures({ approverGroups: ['Sysadmins', 'NetEng'] });
    // Dave is only in NetEng (the second one).
    addUserToGroup(dave.id, groupIds[1]);
    setApproverGroups('server_reboot', groupIds);

    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);

    const res = await dave.agent.post(`/api/changes/${id}/approve`);
    expect(res.status).toBe(200);
  });

  test('admin can always approve, regardless of group membership', async () => {
    const { admin, bob, groupIds } = await setupFixtures({ approverGroups: ['Reviewers'] });
    setApproverGroups('server_reboot', groupIds);

    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);

    const res = await admin.post(`/api/changes/${id}/approve`);
    expect(res.status).toBe(200);
  });

  test('submitter cannot approve own change, even if in the group', async () => {
    const { bob, groupIds } = await setupFixtures({ approverGroups: ['Reviewers'] });
    addUserToGroup(bob.id, groupIds[0]);
    setApproverGroups('server_reboot', groupIds);

    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);

    const res = await bob.agent.post(`/api/changes/${id}/approve`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own change/);
  });

  test('reject also requires group membership (or admin)', async () => {
    const { bob, eve, groupIds } = await setupFixtures({ approverGroups: ['Reviewers'] });
    setApproverGroups('server_reboot', groupIds);

    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);

    const res = await eve.agent.post(`/api/changes/${id}/reject`).send({ comment: 'no' });
    expect(res.status).toBe(403);
  });

  test('legacy: with no approver groups assigned, the approver role works', async () => {
    const { bob, eve } = await setupFixtures(); // no groups assigned to server_reboot
    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);
    const res = await eve.agent.post(`/api/changes/${id}/approve`);
    expect(res.status).toBe(200);
  });

  test('legacy: with no approver groups, plain submitter still cannot approve', async () => {
    const { bob, dave } = await setupFixtures();
    const id = await createServerReboot(bob.agent);
    await bob.agent.post(`/api/changes/${id}/submit`);
    const res = await dave.agent.post(`/api/changes/${id}/approve`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/changes/:id includes requiredApprovalGroups', () => {
  test('returns groups configured for the type', async () => {
    const { bob, groupIds } = await setupFixtures({ approverGroups: ['G1', 'G2'] });
    setApproverGroups('server_reboot', groupIds);
    const id = await createServerReboot(bob.agent);
    const res = await bob.agent.get(`/api/changes/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.requiredApprovalGroups.map(g => g.name).sort()).toEqual(['G1', 'G2']);
  });

  test('returns [] when no groups configured', async () => {
    const { bob } = await setupFixtures();
    const id = await createServerReboot(bob.agent);
    const res = await bob.agent.get(`/api/changes/${id}`);
    expect(res.body.requiredApprovalGroups).toEqual([]);
  });
});
