import { describe, test, expect } from 'vitest';
import { client } from './helpers.js';

describe('Public meta endpoints', () => {
  test('GET /api/health returns ok + version', async () => {
    const res = await client().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: expect.any(String) });
  });

  test('GET /api returns the endpoint index', async () => {
    const res = await client().get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('cambiar');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(res.body.endpoints.length).toBeGreaterThan(5);
  });
});
