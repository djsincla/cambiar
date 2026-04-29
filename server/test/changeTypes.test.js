import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, agentFor, client } from './helpers.js';

async function authedAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('GET /api/change-types', () => {
  beforeEach(resetDb);

  test('requires auth', async () => {
    const res = await client().get('/api/change-types');
    expect(res.status).toBe(401);
  });

  test('returns the seeded type catalog', async () => {
    const a = await authedAgent();
    const res = await a.get('/api/change-types');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.types)).toBe(true);
    const keys = res.body.types.map(t => t.key);
    expect(keys).toEqual(expect.arrayContaining([
      'server_reboot', 'firewall_rule', 'software_update', 'storage_change', 'network_change', 'generic',
    ]));
  });

  test('every type declares required structural keys', async () => {
    const a = await authedAgent();
    const { body } = await a.get('/api/change-types');
    for (const t of body.types) {
      expect(t).toMatchObject({ key: expect.any(String), name: expect.any(String) });
      expect(Array.isArray(t.fields)).toBe(true);
      for (const f of t.fields) {
        expect(f.key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(['string', 'text', 'number', 'select', 'boolean']).toContain(f.type);
        if (f.type === 'select') expect(Array.isArray(f.options)).toBe(true);
      }
    }
  });
});

describe('GET /api/change-types/:key', () => {
  beforeEach(resetDb);

  test('returns a known type', async () => {
    const a = await authedAgent();
    const res = await a.get('/api/change-types/server_reboot');
    expect(res.status).toBe(200);
    expect(res.body.type.key).toBe('server_reboot');
    expect(res.body.type.fields.find(f => f.key === 'host')).toBeDefined();
  });

  test('404 on unknown', async () => {
    const a = await authedAgent();
    const res = await a.get('/api/change-types/no_such_thing');
    expect(res.status).toBe(404);
  });
});
