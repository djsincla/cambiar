import { describe, test, expect, beforeEach } from 'vitest';
import {
  resetDb, createUser, createGroup, addUserToGroup, agentFor, setApproverGroups, row,
} from './helpers.js';
import { db } from '../src/db/index.js';

const REBOOT_FIELDS = { host: 'render-12.local', reason: 'Patch', expected_downtime_minutes: 5 };

async function setup({ approverGroups = [] } = {}) {
  resetDb();
  const adminA = await agentFor('admin', 'admin');
  await adminA.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });

  // Cast: bob/carol = submitter; dave = submitter (also a group member); eve = approver role; mallory = inactive
  const bob   = createUser({ username: 'bob',   password: 'BobPass1234',   role: 'submitter' });
  const carol = createUser({ username: 'carol', password: 'CarolPass1234', role: 'submitter' });
  const dave  = createUser({ username: 'dave',  password: 'DavePass1234',  role: 'submitter' });
  const eve   = createUser({ username: 'eve',   password: 'EvePass12345',  role: 'approver' });

  const groupIds = [];
  for (const groupName of approverGroups) {
    const g = createGroup({ name: groupName });
    groupIds.push(g.id);
  }

  return {
    admin: adminA,
    bob: { ...bob, agent: await agentFor('bob', 'BobPass1234') },
    carol: { ...carol, agent: await agentFor('carol', 'CarolPass1234') },
    dave: { ...dave, agent: await agentFor('dave', 'DavePass1234') },
    eve: { ...eve, agent: await agentFor('eve', 'EvePass12345') },
    groupIds,
  };
}

async function bobSubmitsReboot(bob) {
  const create = await bob.agent.post('/api/changes').send({
    typeKey: 'server_reboot', title: 'Reboot render-12', fields: REBOOT_FIELDS,
  });
  await bob.agent.post(`/api/changes/${create.body.change.id}/submit`);
  return create.body.change.id;
}

describe('GET /api/changes?awaitingMyApproval=true', () => {
  test('plain submitter sees an empty inbox', async () => {
    const { bob, carol } = await setup();
    await bobSubmitsReboot(bob);
    const res = await carol.agent.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toEqual([]);
  });

  test('admin sees all submitted changes (override) — except their own', async () => {
    const { admin, bob } = await setup();
    await bobSubmitsReboot(bob);
    // Admin submits one too — should not appear in their own inbox.
    const adminCreate = await admin.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Admin reboot', fields: REBOOT_FIELDS,
    });
    await admin.post(`/api/changes/${adminCreate.body.change.id}/submit`);

    const res = await admin.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].submitter.username).toBe('bob');
  });

  test('group member sees changes whose type assigns their group', async () => {
    const { bob, carol, groupIds } = await setup({ approverGroups: ['Reviewers'] });
    addUserToGroup(carol.id, groupIds[0]);
    setApproverGroups('server_reboot', groupIds);

    await bobSubmitsReboot(bob);
    const res = await carol.agent.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toHaveLength(1);
  });

  test('group member does NOT see types that assign a different group', async () => {
    const { bob, carol, groupIds } = await setup({ approverGroups: ['Sysadmins', 'NetEng'] });
    // Carol is in the second group; reboot assigns the first.
    addUserToGroup(carol.id, groupIds[1]);
    setApproverGroups('server_reboot', [groupIds[0]]);

    await bobSubmitsReboot(bob);
    const res = await carol.agent.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toEqual([]);
  });

  test('multi-group user sees changes for ANY of their groups (any-one-group)', async () => {
    const { bob, dave, groupIds } = await setup({ approverGroups: ['Sysadmins', 'NetEng'] });
    // Dave is in NetEng only; reboot assigns Sysadmins+NetEng.
    addUserToGroup(dave.id, groupIds[1]);
    setApproverGroups('server_reboot', groupIds);

    await bobSubmitsReboot(bob);
    const res = await dave.agent.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toHaveLength(1);
  });

  test('legacy: approver-role user sees types with NO groups assigned', async () => {
    const { bob, eve } = await setup(); // server_reboot has no groups
    await bobSubmitsReboot(bob);
    const res = await eve.agent.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toHaveLength(1);
  });

  test('legacy: approver-role user does NOT see types with groups assigned (groups take precedence)', async () => {
    const { bob, eve, groupIds } = await setup({ approverGroups: ['SomeGroup'] });
    setApproverGroups('server_reboot', groupIds);

    await bobSubmitsReboot(bob);
    const res = await eve.agent.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toEqual([]);
  });

  test('users own submitted change is excluded from their own inbox', async () => {
    const { bob, groupIds } = await setup({ approverGroups: ['Reviewers'] });
    addUserToGroup(bob.id, groupIds[0]);
    setApproverGroups('server_reboot', groupIds);

    await bobSubmitsReboot(bob);
    const res = await bob.agent.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toEqual([]);
  });

  test('non-submitted statuses are excluded from inbox', async () => {
    const { admin, bob } = await setup();
    const id = await bobSubmitsReboot(bob);
    // Admin approves → status moves to 'approved' → no longer in any inbox.
    await admin.post(`/api/changes/${id}/approve`);

    const res = await admin.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toEqual([]);
  });

  test('inbox sort is oldest-first (queue order)', async () => {
    const { admin, bob, carol } = await setup();
    const first = await bobSubmitsReboot(bob);
    // Bump submitted_at deterministically.
    db.prepare("UPDATE changes SET submitted_at = '2026-04-01 09:00:00' WHERE id = ?").run(first);

    const create2 = await carol.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Carol reboot', fields: REBOOT_FIELDS,
    });
    await carol.agent.post(`/api/changes/${create2.body.change.id}/submit`);
    db.prepare("UPDATE changes SET submitted_at = '2026-04-02 09:00:00' WHERE id = ?")
      .run(create2.body.change.id);

    const res = await admin.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes.map(c => c.id)).toEqual([first, create2.body.change.id]);
  });

  test('changes for a deactivated change type still appear (no orphans)', async () => {
    const { admin, bob } = await setup();
    const id = await bobSubmitsReboot(bob);
    // Admin deactivates the type AFTER submission.
    db.prepare("UPDATE change_types SET active = 0 WHERE key = 'server_reboot'").run();

    const res = await admin.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes.map(c => c.id)).toContain(id);
  });

  test('changes for an auto-approved type never reach inbox', async () => {
    const { admin, bob } = await setup();
    db.prepare("UPDATE change_types SET auto_approve = 1 WHERE key = 'server_reboot'").run();

    const create = await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Auto', fields: REBOOT_FIELDS,
    });
    const sub = await bob.agent.post(`/api/changes/${create.body.change.id}/submit`);
    expect(sub.body.change.status).toBe('approved'); // jumped past submitted

    const res = await admin.get('/api/changes?awaitingMyApproval=true');
    expect(res.body.changes).toEqual([]);
  });
});

describe('Notification recipients use the same predicate as the inbox', () => {
  // We don't actually send mail in tests; we just inspect what recipientsFor
  // would return. The simplest check: trigger a submit and confirm the right
  // people would have been notified by checking who eligibleApproverIds picks.
  test('submitted goes to admins + members of assigned groups, NOT submitter', async () => {
    const { bob, carol, dave, eve, groupIds } = await setup({ approverGroups: ['Reviewers'] });
    addUserToGroup(carol.id, groupIds[0]);
    addUserToGroup(dave.id, groupIds[0]); // also in group
    setApproverGroups('server_reboot', groupIds);

    const { eligibleApproverIds } = await import('../src/services/groups.js');
    const ct = row('SELECT id FROM change_types WHERE key = ?', 'server_reboot');
    const ids = eligibleApproverIds({
      changeTypeId: ct.id,
      hasApproverGroups: true,
      excludeUserId: bob.id,
    });
    const usernames = ids
      .map(id => row('SELECT username FROM users WHERE id = ?', id).username)
      .sort();
    expect(usernames).toEqual(['admin', 'carol', 'dave']);
    // eve has approver-role but is NOT in the group; not notified.
    expect(usernames).not.toContain('eve');
    // bob is the submitter; not notified.
    expect(usernames).not.toContain('bob');
  });

  test('submitted on type with no groups falls back to legacy approver-role + admins', async () => {
    const { bob, eve } = await setup(); // no groups configured
    const { eligibleApproverIds } = await import('../src/services/groups.js');
    const ct = row('SELECT id FROM change_types WHERE key = ?', 'server_reboot');
    const ids = eligibleApproverIds({
      changeTypeId: ct.id,
      hasApproverGroups: false,
      excludeUserId: bob.id,
    });
    const usernames = ids
      .map(id => row('SELECT username FROM users WHERE id = ?', id).username)
      .sort();
    expect(usernames).toEqual(['admin', 'eve']);
  });
});
