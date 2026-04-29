import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, createGroup, addUserToGroup, agentFor, rows } from './helpers.js';

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('Users API includes group memberships', () => {
  beforeEach(resetDb);

  test('GET /api/users returns groups[] per user', async () => {
    const u = createUser({ username: 'bob', password: 'BobP1234567' });
    const g1 = createGroup({ name: 'G1' });
    const g2 = createGroup({ name: 'G2' });
    addUserToGroup(u.id, g1.id);
    addUserToGroup(u.id, g2.id);

    const a = await adminAgent();
    const res = await a.get('/api/users');
    const bob = res.body.users.find(x => x.username === 'bob');
    expect(bob.groups.map(g => g.name).sort()).toEqual(['G1', 'G2']);
  });

  test('POST /api/users accepts groupIds and assigns them', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'NetEng' });
    const res = await a.post('/api/users').send({
      username: 'alice', password: 'AlicePass1234', groupIds: [g.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.user.groups).toEqual([{ id: g.id, name: 'NetEng', description: null }]);
  });

  test('PATCH /api/users/:id accepts groupIds and replaces membership atomically', async () => {
    const u = createUser({ username: 'bob', password: 'BobP1234567' });
    const g1 = createGroup({ name: 'G1' });
    const g2 = createGroup({ name: 'G2' });
    addUserToGroup(u.id, g1.id);

    const a = await adminAgent();
    const res = await a.patch(`/api/users/${u.id}`).send({ groupIds: [g2.id] });
    expect(res.status).toBe(200);
    expect(res.body.user.groups.map(g => g.name)).toEqual(['G2']);
    expect(rows('SELECT group_id FROM user_groups WHERE user_id = ?', u.id).map(r => r.group_id)).toEqual([g2.id]);
  });

  test('PATCH groupIds=[] clears all memberships', async () => {
    const u = createUser({ username: 'bob', password: 'BobP1234567' });
    const g = createGroup({ name: 'G' });
    addUserToGroup(u.id, g.id);

    const a = await adminAgent();
    const res = await a.patch(`/api/users/${u.id}`).send({ groupIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.user.groups).toEqual([]);
  });

  test('rejects unknown groupId', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/users').send({
      username: 'alice', password: 'AlicePass1234', groupIds: [9999],
    });
    expect(res.status).toBe(400);
  });
});
