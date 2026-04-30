import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, client } from './helpers.js';

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('GET /api/release-notes', () => {
  beforeEach(resetDb);

  test('returns CHANGELOG.md content for an authed user', async () => {
    const a = await adminAgent();
    const res = await a.get('/api/release-notes');
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('# Changelog');
    // First version heading should appear (Keep a Changelog format).
    expect(res.body.content).toMatch(/##\s*\[\d+\.\d+\.\d+\]/);
  });

  test('any authed user can read release notes (not admin-gated)', async () => {
    createUser({ username: 'bob', password: 'BobPass1234' });
    const a = await agentFor('bob', 'BobPass1234');
    // bob has must_change_password=0 by default in createUser, so this hits the route directly.
    const res = await a.get('/api/release-notes');
    expect(res.status).toBe(200);
  });

  test('401 without auth', async () => {
    const res = await client().get('/api/release-notes');
    expect(res.status).toBe(401);
  });

  test('blocked while user must change password', async () => {
    const a = await agentFor('admin', 'admin'); // bootstrap admin → must_change_password=1
    const res = await a.get('/api/release-notes');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});
