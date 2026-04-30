import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, row, rows } from './helpers.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

async function setupChangeBy(agent) {
  const r = await agent.post('/api/changes').send({
    typeKey: 'server_reboot', title: 'Notes test', fields: REBOOT_FIELDS,
  });
  return r.body.change.id;
}

describe('Change notes', () => {
  beforeEach(resetDb);

  test('add and list notes (chronological, with author)', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const n1 = await a.post(`/api/changes/${id}/notes`).send({ body: 'First note **bold**' });
    expect(n1.status).toBe(201);
    expect(n1.body.note.body).toBe('First note **bold**');
    expect(n1.body.note.author.username).toBe('admin');

    await a.post(`/api/changes/${id}/notes`).send({ body: 'Second note' });

    const list = await a.get(`/api/changes/${id}/notes`);
    expect(list.body.notes.map(n => n.body)).toEqual(['First note **bold**', 'Second note']);
  });

  test('any authed user can add notes; only author or admin can edit/delete', async () => {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');

    const id = await setupChangeBy(bob);
    const noteByBob = await bob.post(`/api/changes/${id}/notes`).send({ body: 'Bob note' });
    expect(noteByBob.status).toBe(201);

    // Admin can edit Bob's note.
    const edited = await a.patch(`/api/changes/${id}/notes/${noteByBob.body.note.id}`).send({ body: 'edited by admin' });
    expect(edited.status).toBe(200);
    expect(edited.body.note.body).toBe('edited by admin');

    // A non-admin non-author cannot edit.
    createUser({ username: 'eve', password: 'EvePass12345' });
    const eve = await agentFor('eve', 'EvePass12345');
    const reject = await eve.patch(`/api/changes/${id}/notes/${noteByBob.body.note.id}`).send({ body: 'hijack' });
    expect(reject.status).toBe(403);
  });

  test('delete by author works and audit row recorded', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const n = await a.post(`/api/changes/${id}/notes`).send({ body: 'kill me' });
    const del = await a.delete(`/api/changes/${id}/notes/${n.body.note.id}`);
    expect(del.status).toBe(200);
    expect(rows('SELECT * FROM change_notes WHERE id = ?', n.body.note.id)).toEqual([]);
    const audit = rows('SELECT action FROM audit_log WHERE change_id = ? AND action = ?', id, 'note_delete');
    expect(audit).toHaveLength(1);
  });

  test('rejects empty body', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const res = await a.post(`/api/changes/${id}/notes`).send({ body: '' });
    expect(res.status).toBe(400);
  });

  test('404 on unknown change', async () => {
    const a = await adminAgent();
    const res = await a.post(`/api/changes/9999/notes`).send({ body: 'ghost' });
    expect(res.status).toBe(404);
  });
});

describe('Change attachments', () => {
  beforeEach(resetDb);

  test('upload an image, list it, fetch the file', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    // 1×1 PNG.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const up = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', png, 'screenshot.png');
    expect(up.status).toBe(201);
    expect(up.body.attachment.url).toMatch(new RegExp(`^/uploads/changes/${id}/att-[a-f0-9]+\\.png$`));

    const list = await a.get(`/api/changes/${id}/attachments`);
    expect(list.body.attachments).toHaveLength(1);
    expect(list.body.attachments[0].originalFilename).toBe('screenshot.png');
    expect(list.body.attachments[0].mimeType).toBe('image/png');
  });

  test('rejects disallowed mime types', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const exe = Buffer.from('MZbinary');
    const res = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', exe, { filename: 'hack.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disallowed/i);
  });

  test('rejects files over 10 MB', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    const res = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', big, { filename: 'huge.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  test('only uploader or admin can delete', async () => {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');
    const id = await setupChangeBy(bob);

    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const up = await bob.post(`/api/changes/${id}/attachments`).attach('file', png, 's.png');

    // Eve is some other user.
    createUser({ username: 'eve', password: 'EvePass12345' });
    const eve = await agentFor('eve', 'EvePass12345');
    const reject = await eve.delete(`/api/changes/${id}/attachments/${up.body.attachment.id}`);
    expect(reject.status).toBe(403);

    // Admin can delete.
    const ok = await a.delete(`/api/changes/${id}/attachments/${up.body.attachment.id}`);
    expect(ok.status).toBe(200);
  });
});
