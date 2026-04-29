import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, createGroup, agentFor, row } from './helpers.js';

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('POST /api/change-types', () => {
  beforeEach(resetDb);

  test('admin creates a new type with custom fields and approver groups', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'NetTeam' });

    const res = await a.post('/api/change-types').send({
      key: 'dns_change',
      name: 'DNS Change',
      description: 'DNS record add/modify',
      icon: 'globe',
      fields: [
        { key: 'zone', label: 'Zone', type: 'string', required: true },
        { key: 'record', label: 'Record', type: 'string', required: true },
        { key: 'kind', label: 'Kind', type: 'select', required: true, options: ['A', 'AAAA', 'CNAME', 'TXT'] },
      ],
      approverGroupIds: [g.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toMatchObject({ key: 'dns_change', name: 'DNS Change', active: true });
    expect(res.body.type.fields).toHaveLength(3);
    expect(res.body.type.approverGroups).toEqual([{ id: g.id, name: 'NetTeam' }]);
  });

  test('rejects duplicate key', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/change-types').send({
      key: 'server_reboot', // already seeded
      name: 'Dupe',
      fields: [],
    });
    expect(res.status).toBe(409);
  });

  test('rejects duplicate field keys', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/change-types').send({
      key: 'dupes',
      name: 'X',
      fields: [
        { key: 'host', label: 'A', type: 'string' },
        { key: 'host', label: 'B', type: 'string' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate field key/);
  });

  test('rejects select field without options', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/change-types').send({
      key: 'sel',
      name: 'X',
      fields: [{ key: 'k', label: 'k', type: 'select' }],
    });
    expect(res.status).toBe(400);
  });

  test('rejects unknown approverGroupId', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/change-types').send({
      key: 'badg', name: 'X', fields: [], approverGroupIds: [9999],
    });
    expect(res.status).toBe(400);
  });

  test('non-admin cannot create', async () => {
    createUser({ username: 'bob', password: 'BobP1234567' });
    const a = await agentFor('bob', 'BobP1234567');
    const res = await a.post('/api/change-types').send({ key: 'x', name: 'X', fields: [] });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/change-types/:id', () => {
  beforeEach(resetDb);

  test('admin edits fields, name, and approver groups', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'Reboot Approvers' });

    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;

    const res = await a.patch(`/api/change-types/${reboot.id}`).send({
      name: 'Server Reboot (renamed)',
      approverGroupIds: [g.id],
      fields: [
        ...reboot.fields,
        { key: 'change_window', label: 'Change window', type: 'string' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.type.name).toBe('Server Reboot (renamed)');
    expect(res.body.type.fields.find(f => f.key === 'change_window')).toBeDefined();
    expect(res.body.type.approverGroups).toEqual([{ id: g.id, name: 'Reboot Approvers' }]);
  });

  test('admin can deactivate', async () => {
    const a = await adminAgent();
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    const res = await a.patch(`/api/change-types/${reboot.id}`).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.type.active).toBe(false);

    // Default list (active only) should not include it now.
    const list = await a.get('/api/change-types');
    expect(list.body.types.find(t => t.key === 'server_reboot')).toBeUndefined();
    // But admin can opt in.
    const listAll = await a.get('/api/change-types?includeInactive=true');
    expect(listAll.body.types.find(t => t.key === 'server_reboot')).toBeDefined();
  });

  test('rejects unknown fields strictly', async () => {
    const a = await adminAgent();
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    const res = await a.patch(`/api/change-types/${reboot.id}`).send({ totallyMadeUp: 1 });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/change-types/:id', () => {
  beforeEach(resetDb);

  test('soft-deletes if change records reference the type', async () => {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobP1234567' });
    const bob = await agentFor('bob', 'BobP1234567');
    await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't',
      fields: { host: 'h', reason: 'r', expected_downtime_minutes: 1 },
    });
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    const res = await a.delete(`/api/change-types/${reboot.id}`);
    expect(res.status).toBe(200);
    expect(res.body.soft).toBe(true);
    // The row still exists but is inactive.
    const after = row('SELECT active FROM change_types WHERE id = ?', reboot.id);
    expect(after.active).toBe(0);
  });

  test('hard-deletes if no references', async () => {
    const a = await adminAgent();
    const create = await a.post('/api/change-types').send({ key: 'tmp', name: 'Temp', fields: [] });
    const res = await a.delete(`/api/change-types/${create.body.type.id}`);
    expect(res.status).toBe(200);
    expect(res.body.soft).toBe(false);
    expect(row('SELECT * FROM change_types WHERE id = ?', create.body.type.id)).toBeUndefined();
  });
});
