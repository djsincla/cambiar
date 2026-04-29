import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, createGroup, agentFor, client, row, setApproverGroups } from './helpers.js';

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('GET /api/groups', () => {
  beforeEach(resetDb);

  test('any authed user can list groups', async () => {
    createGroup({ name: 'Sysadmins' });
    createGroup({ name: 'NetEng' });
    createUser({ username: 'bob', password: 'BobPass1234' });
    const a = await agentFor('bob', 'BobPass1234');
    const res = await a.get('/api/groups');
    expect(res.status).toBe(200);
    expect(res.body.groups.map(g => g.name).sort()).toEqual(['NetEng', 'Sysadmins']);
  });

  test('member_count is included', async () => {
    const a = await adminAgent();
    const create = await a.post('/api/groups').send({ name: 'Reviewers' });
    const userA = createUser({ username: 'alice', password: 'AliceP1234' });
    const userB = createUser({ username: 'bob', password: 'BobP1234567' });
    await a.post(`/api/groups/${create.body.group.id}/members`).send({ userId: userA.id });
    await a.post(`/api/groups/${create.body.group.id}/members`).send({ userId: userB.id });

    const list = await a.get('/api/groups');
    const reviewers = list.body.groups.find(g => g.name === 'Reviewers');
    expect(reviewers.memberCount).toBe(2);
  });

  test('401 without auth', async () => {
    const res = await client().get('/api/groups');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/groups', () => {
  beforeEach(resetDb);

  test('admin creates a group, optionally with initial members', async () => {
    const a = await adminAgent();
    const u = createUser({ username: 'bob', password: 'BobP1234567' });
    const res = await a.post('/api/groups').send({ name: 'Sysadmins', description: 'Server team', memberIds: [u.id] });
    expect(res.status).toBe(201);
    expect(res.body.group).toMatchObject({ name: 'Sysadmins', description: 'Server team' });
    expect(res.body.group.members.map(m => m.username)).toEqual(['bob']);
  });

  test('rejects duplicate name', async () => {
    const a = await adminAgent();
    await a.post('/api/groups').send({ name: 'Dupes' });
    const res = await a.post('/api/groups').send({ name: 'Dupes' });
    expect(res.status).toBe(409);
  });

  test('rejects invalid name', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/groups').send({ name: 'has@illegal' });
    expect(res.status).toBe(400);
  });

  test('non-admin cannot create', async () => {
    createUser({ username: 'bob', password: 'BobP1234567' });
    const a = await agentFor('bob', 'BobP1234567');
    const res = await a.post('/api/groups').send({ name: 'Try' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/groups/:id', () => {
  beforeEach(resetDb);

  test('admin updates name + members atomically', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'NetEng' });
    const u1 = createUser({ username: 'alice', password: 'AliceP1234' });
    const u2 = createUser({ username: 'bob', password: 'BobP1234567' });

    const res = await a.patch(`/api/groups/${g.id}`).send({ name: 'Network', memberIds: [u1.id, u2.id] });
    expect(res.status).toBe(200);
    expect(res.body.group.name).toBe('Network');
    expect(res.body.group.members.map(m => m.username).sort()).toEqual(['alice', 'bob']);

    // Now drop bob via PATCH.
    const res2 = await a.patch(`/api/groups/${g.id}`).send({ memberIds: [u1.id] });
    expect(res2.body.group.members.map(m => m.username)).toEqual(['alice']);
  });

  test('rejects unknown fields strictly', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'X' });
    const res = await a.patch(`/api/groups/${g.id}`).send({ secret: 1 });
    expect(res.status).toBe(400);
  });

  test('404 unknown group', async () => {
    const a = await adminAgent();
    const res = await a.patch('/api/groups/9999').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/groups/:id', () => {
  beforeEach(resetDb);

  test('refuses delete if assigned as approver group', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'Approvers' });
    setApproverGroups('server_reboot', [g.id]);
    const res = await a.delete(`/api/groups/${g.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/assigned as approver/);
  });

  test('deletes if unassigned', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'Tmp' });
    const res = await a.delete(`/api/groups/${g.id}`);
    expect(res.status).toBe(200);
    expect(row('SELECT * FROM groups WHERE id = ?', g.id)).toBeUndefined();
  });
});

describe('Group members endpoints', () => {
  beforeEach(resetDb);

  test('add and remove a member', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'G' });
    const u = createUser({ username: 'bob', password: 'BobP1234567' });

    const add = await a.post(`/api/groups/${g.id}/members`).send({ userId: u.id });
    expect(add.status).toBe(200);
    expect(add.body.group.members[0].username).toBe('bob');

    const del = await a.delete(`/api/groups/${g.id}/members/${u.id}`);
    expect(del.status).toBe(200);
    expect(del.body.group.members).toHaveLength(0);
  });

  test('rejects unknown user id', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'G' });
    const res = await a.post(`/api/groups/${g.id}/members`).send({ userId: 9999 });
    expect(res.status).toBe(400);
  });
});
