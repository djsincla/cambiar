import { describe, test, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

  test('on-disk filename uses extension from validated mimetype, not user-supplied filename (stored XSS hardening)', async () => {
    // Pre-fix attack: name a file evil.html, declare mimetype image/png. The
    // mimetype check passed but the on-disk extension came from the original
    // filename, so express.static served the upload as text/html and any
    // embedded JS executed in cambiar's origin under the victim's session.
    // Post-fix: extension is derived from the (allowed) mimetype, so a .html
    // tail can never land on disk through this endpoint.
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const html = Buffer.from('<script>fetch("/api/users")</script>');
    const res = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', html, { filename: 'evil.html', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.attachment.url).toMatch(/\.png$/);
    expect(res.body.attachment.url).not.toMatch(/\.html/);
    // Original filename is preserved in the response (informational only).
    expect(res.body.attachment.originalFilename).toBe('evil.html');
  });

  test('rejects SVG uploads (XSS risk — SVG can carry <script>)', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', svg, { filename: 'evil.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disallowed/i);
  });

  test('/uploads responses carry X-Content-Type-Options: nosniff', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const up = await a.post(`/api/changes/${id}/attachments`).attach('file', png, 'shot.png');
    const fetched = await a.get(up.body.attachment.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
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

describe('Attachments threaded under notes', () => {
  beforeEach(resetDb);

  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
    'hex',
  );

  test('upload with noteId threads it under that note; scope filter splits the views', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const note = (await a.post(`/api/changes/${id}/notes`).send({ body: 'investigation log' })).body.note;

    const threaded = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', PNG, 'evidence.png')
      .field('noteId', String(note.id));
    expect(threaded.status).toBe(201);
    expect(threaded.body.attachment.noteId).toBe(note.id);

    const wide = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', PNG, 'general.png');
    expect(wide.body.attachment.noteId).toBeNull();

    // scope=change-wide returns only the un-threaded one.
    const widthList = (await a.get(`/api/changes/${id}/attachments?scope=change-wide`)).body.attachments;
    expect(widthList).toHaveLength(1);
    expect(widthList[0].id).toBe(wide.body.attachment.id);

    // scope=note&noteId returns only the threaded one.
    const noteList = (await a.get(`/api/changes/${id}/attachments?scope=note&noteId=${note.id}`)).body.attachments;
    expect(noteList).toHaveLength(1);
    expect(noteList[0].id).toBe(threaded.body.attachment.id);

    // No scope = both (legacy).
    const all = (await a.get(`/api/changes/${id}/attachments`)).body.attachments;
    expect(all).toHaveLength(2);
  });

  test('rejects noteId belonging to a different change', async () => {
    const a = await adminAgent();
    const id1 = await setupChangeBy(a);
    const id2 = await setupChangeBy(a);
    const note2 = (await a.post(`/api/changes/${id2}/notes`).send({ body: 'on the other change' })).body.note;

    const res = await a.post(`/api/changes/${id1}/attachments`)
      .attach('file', PNG, 'cross-link.png')
      .field('noteId', String(note2.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);
  });

  test('deleting a note cascades its threaded attachments', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const note = (await a.post(`/api/changes/${id}/notes`).send({ body: 'temp' })).body.note;
    await a.post(`/api/changes/${id}/attachments`).attach('file', PNG, 'a.png').field('noteId', String(note.id));
    await a.post(`/api/changes/${id}/attachments`).attach('file', PNG, 'b.png').field('noteId', String(note.id));

    expect(rows('SELECT id FROM change_attachments WHERE note_id = ?', note.id)).toHaveLength(2);
    await a.delete(`/api/changes/${id}/notes/${note.id}`);
    expect(rows('SELECT id FROM change_attachments WHERE note_id = ?', note.id)).toHaveLength(0);
  });

  test('deleting a note unlinks threaded files from disk (not just DB rows)', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const note = (await a.post(`/api/changes/${id}/notes`).send({ body: 'evidence' })).body.note;
    const up = (await a.post(`/api/changes/${id}/attachments`)
      .attach('file', PNG, 'shot.png')
      .field('noteId', String(note.id))).body.attachment;

    const onDisk = resolve(process.env.DATA_DIR, 'uploads/changes', String(id), up.filename);
    expect(existsSync(onDisk)).toBe(true);

    await a.delete(`/api/changes/${id}/notes/${note.id}`);
    expect(existsSync(onDisk)).toBe(false);
  });

  test('deleting a draft change unlinks all its attachment files', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const a1 = (await a.post(`/api/changes/${id}/attachments`).attach('file', PNG, 'a.png')).body.attachment;
    const a2 = (await a.post(`/api/changes/${id}/attachments`).attach('file', PNG, 'b.png')).body.attachment;

    const p1 = resolve(process.env.DATA_DIR, 'uploads/changes', String(id), a1.filename);
    const p2 = resolve(process.env.DATA_DIR, 'uploads/changes', String(id), a2.filename);
    expect(existsSync(p1) && existsSync(p2)).toBe(true);

    await a.delete(`/api/changes/${id}`);
    expect(existsSync(p1)).toBe(false);
    expect(existsSync(p2)).toBe(false);
  });

  test('rejects malformed noteId', async () => {
    const a = await adminAgent();
    const id = await setupChangeBy(a);
    const res = await a.post(`/api/changes/${id}/attachments`)
      .attach('file', PNG, 'x.png')
      .field('noteId', 'not-a-number');
    expect(res.status).toBe(400);
  });
});
