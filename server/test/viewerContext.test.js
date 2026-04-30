import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, createGroup, addUserToGroup, agentFor, setApproverGroups, row } from './helpers.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function setup({ approverGroups = [] } = {}) {
  resetDb();
  const adminA = await agentFor('admin', 'admin');
  await adminA.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });

  const bob = createUser({ username: 'bob', password: 'BobPass1234', role: 'submitter' });
  const carol = createUser({ username: 'carol', password: 'CarolPass1234', role: 'submitter' });

  const groupIds = [];
  for (const groupName of approverGroups) {
    const g = createGroup({ name: groupName });
    groupIds.push(g.id);
  }

  return {
    admin: adminA,
    bob: { ...bob, agent: await agentFor('bob', 'BobPass1234') },
    carol: { ...carol, agent: await agentFor('carol', 'CarolPass1234') },
    groupIds,
  };
}

async function bobSubmitsReboot(bob) {
  const create = await bob.agent.post('/api/changes').send({
    typeKey: 'server_reboot', title: 'Reboot', fields: REBOOT_FIELDS,
  });
  await bob.agent.post(`/api/changes/${create.body.change.id}/submit`);
  return create.body.change.id;
}

describe('viewer-context annotation (viewerIsSubmitter, viewerCanApprove)', () => {
  test('list flags submitter on their own draft', async () => {
    const { bob } = await setup();
    await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Bob draft', fields: REBOOT_FIELDS,
    });
    const list = await bob.agent.get('/api/changes');
    const c = list.body.changes[0];
    expect(c.viewerIsSubmitter).toBe(true);
    expect(c.viewerCanApprove).toBe(false); // drafts are never approvable
  });

  test('admin sees viewerCanApprove on submitted by someone else', async () => {
    const { admin, bob } = await setup();
    await bobSubmitsReboot(bob);
    const list = await admin.get('/api/changes');
    const c = list.body.changes[0];
    expect(c.viewerIsSubmitter).toBe(false);
    expect(c.viewerCanApprove).toBe(true);
  });

  test('admin who is the submitter cannot approve their own change', async () => {
    const { admin } = await setup();
    const create = await admin.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Admin reboot', fields: REBOOT_FIELDS,
    });
    await admin.post(`/api/changes/${create.body.change.id}/submit`);
    const list = await admin.get('/api/changes');
    const c = list.body.changes[0];
    expect(c.viewerIsSubmitter).toBe(true);
    expect(c.viewerCanApprove).toBe(false);
  });

  test('group member sees viewerCanApprove only for types where their group is assigned', async () => {
    const { bob, carol, groupIds } = await setup({ approverGroups: ['Reviewers'] });
    addUserToGroup(carol.id, groupIds[0]);
    setApproverGroups('server_reboot', groupIds);
    await bobSubmitsReboot(bob);

    const list = await carol.agent.get('/api/changes');
    const c = list.body.changes[0];
    expect(c.viewerCanApprove).toBe(true);
    expect(c.viewerIsSubmitter).toBe(false);
  });

  test('non-group submitter cannot approve when groups are configured', async () => {
    const { bob, carol, groupIds } = await setup({ approverGroups: ['Reviewers'] });
    // Carol is NOT in the group.
    setApproverGroups('server_reboot', groupIds);
    await bobSubmitsReboot(bob);

    const list = await carol.agent.get('/api/changes');
    const c = list.body.changes[0];
    expect(c.viewerCanApprove).toBe(false);
  });

  test('detail endpoint also returns viewer context', async () => {
    const { admin, bob } = await setup();
    const id = await bobSubmitsReboot(bob);
    const detail = await admin.get(`/api/changes/${id}`);
    expect(detail.body.change.viewerCanApprove).toBe(true);
    expect(detail.body.change.viewerIsSubmitter).toBe(false);
  });
});
