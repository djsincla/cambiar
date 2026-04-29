import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, client } from './helpers.js';
import { db } from '../src/db/index.js';

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

function clearBranding() {
  db.prepare("DELETE FROM settings WHERE key LIKE 'branding.%'").run();
}

describe('GET /api/settings/branding (public)', () => {
  beforeEach(() => { resetDb(); clearBranding(); });

  test('returns defaults when no branding configured', async () => {
    const res = await client().get('/api/settings/branding');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ appName: 'cambiar', logoUrl: null });
  });

  test('does not require authentication', async () => {
    const res = await client().get('/api/settings/branding');
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/settings/branding', () => {
  beforeEach(() => { resetDb(); clearBranding(); });

  test('admin can set appName', async () => {
    const a = await adminAgent();
    const res = await a.put('/api/settings/branding').send({ appName: 'Van Dyke VFX Changes' });
    expect(res.status).toBe(200);
    expect(res.body.appName).toBe('Van Dyke VFX Changes');

    // Visible to anonymous.
    const pub = await client().get('/api/settings/branding');
    expect(pub.body.appName).toBe('Van Dyke VFX Changes');
  });

  test('non-admin cannot change branding', async () => {
    createUser({ username: 'bob', password: 'BobP1234567' });
    const a = await agentFor('bob', 'BobP1234567');
    const res = await a.put('/api/settings/branding').send({ appName: 'Hijack' });
    expect(res.status).toBe(403);
  });

  test('rejects unknown fields strictly', async () => {
    const a = await adminAgent();
    const res = await a.put('/api/settings/branding').send({ secretField: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/settings/branding/logo', () => {
  beforeEach(() => { resetDb(); clearBranding(); });

  test('admin uploads a PNG and the public branding now exposes the logo URL', async () => {
    const a = await adminAgent();
    // 1×1 transparent PNG.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const res = await a.post('/api/settings/branding/logo')
      .attach('logo', png, 'logo.png');
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toMatch(/^\/uploads\/logo-[a-f0-9]+\.png$/);

    // Public branding now reports it.
    const pub = await client().get('/api/settings/branding');
    expect(pub.body.logoUrl).toBe(res.body.logoUrl);

    // The file is served at /uploads/...
    const file = await client().get(res.body.logoUrl);
    expect(file.status).toBe(200);
  });

  test('admin uploads SVG', async () => {
    const a = await adminAgent();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const res = await a.post('/api/settings/branding/logo')
      .attach('logo', svg, { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toMatch(/\.svg$/);
  });

  test('rejects unsupported file types', async () => {
    const a = await adminAgent();
    const txt = Buffer.from('hello');
    const res = await a.post('/api/settings/branding/logo')
      .attach('logo', txt, { filename: 'logo.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  test('rejects files over 1MB', async () => {
    const a = await adminAgent();
    const big = Buffer.alloc(1024 * 1024 + 1, 0); // 1MB + 1 byte
    const res = await a.post('/api/settings/branding/logo')
      .attach('logo', big, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  test('non-admin cannot upload', async () => {
    createUser({ username: 'bob', password: 'BobP1234567' });
    const a = await agentFor('bob', 'BobP1234567');
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const res = await a.post('/api/settings/branding/logo')
      .attach('logo', png, 'logo.png');
    expect(res.status).toBe(403);
  });

  test('uploading a new logo removes the previous one', async () => {
    const a = await adminAgent();
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const first = await a.post('/api/settings/branding/logo').attach('logo', png, 'logo.png');
    const oldUrl = first.body.logoUrl;
    const second = await a.post('/api/settings/branding/logo').attach('logo', png, 'logo2.png');
    expect(second.body.logoUrl).not.toBe(oldUrl);

    // Old file is gone.
    const old = await client().get(oldUrl);
    expect(old.status).toBe(404);
  });
});

describe('DELETE /api/settings/branding/logo', () => {
  beforeEach(() => { resetDb(); clearBranding(); });

  test('admin can clear the logo', async () => {
    const a = await adminAgent();
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const up = await a.post('/api/settings/branding/logo').attach('logo', png, 'logo.png');
    expect(up.body.logoUrl).toBeTruthy();

    const del = await a.delete('/api/settings/branding/logo');
    expect(del.status).toBe(200);
    expect(del.body.logoUrl).toBeNull();
  });

  test('non-admin cannot clear', async () => {
    createUser({ username: 'bob', password: 'BobP1234567' });
    const a = await agentFor('bob', 'BobP1234567');
    const res = await a.delete('/api/settings/branding/logo');
    expect(res.status).toBe(403);
  });
});
