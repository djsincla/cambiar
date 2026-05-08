import { describe, test, expect } from 'vitest';
import { client } from './helpers.js';

describe('Public meta endpoints', () => {
  test('GET /api/health returns ok + version', async () => {
    const res = await client().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: expect.any(String) });
  });

  test('GET /api returns the project metadata', async () => {
    const res = await client().get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('cambiar.world');
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body.docs).toMatch(/^https:\/\//);
    expect(res.body.source).toMatch(/^https:\/\/github\.com\//);
    expect(res.body.issues).toMatch(/^https:\/\/github\.com\//);
  });
});
