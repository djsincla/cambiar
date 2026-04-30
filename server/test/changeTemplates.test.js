import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, row } from './helpers.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('Change templates CRUD', () => {
  beforeEach(resetDb);

  test('create a template and list it', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/change-templates').send({
      name: 'Monthly patch window',
      description: 'Standard patching template',
      typeKey: 'server_reboot',
      title: 'Monthly patch — {{host}}',
      bodyDescription: 'Routine monthly patch',
      fields: REBOOT_FIELDS,
      plannedDurationMinutes: 60,
    });
    expect(res.status).toBe(201);
    expect(res.body.template).toMatchObject({
      name: 'Monthly patch window',
      typeKey: 'server_reboot',
      plannedDurationMinutes: 60,
    });

    const list = await a.get('/api/change-templates');
    expect(list.body.templates.map(t => t.name)).toContain('Monthly patch window');
  });

  test('rejects duplicate name', async () => {
    const a = await adminAgent();
    await a.post('/api/change-templates').send({
      name: 'Dup', typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
    });
    const res = await a.post('/api/change-templates').send({
      name: 'Dup', typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
    });
    expect(res.status).toBe(409);
  });

  test('rejects unknown change type', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/change-templates').send({
      name: 'BadType', typeKey: 'no_such', title: 't',
    });
    expect(res.status).toBe(400);
  });

  test('only creator or admin can edit/delete', async () => {
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');
    const created = await bob.post('/api/change-templates').send({
      name: 'Bob template', typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
    });

    createUser({ username: 'eve', password: 'EvePass12345' });
    const eve = await agentFor('eve', 'EvePass12345');
    const reject = await eve.patch(`/api/change-templates/${created.body.template.id}`).send({ name: 'hijack' });
    expect(reject.status).toBe(403);

    // Admin can edit.
    const a = await adminAgent();
    const ok = await a.patch(`/api/change-templates/${created.body.template.id}`).send({ name: 'admin-renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.template.name).toBe('admin-renamed');
  });
});

describe('Creating changes from templates / by copy', () => {
  beforeEach(resetDb);

  test('POST /api/changes with templateId pre-fills title/type/fields/duration', async () => {
    const a = await adminAgent();
    const t = await a.post('/api/change-templates').send({
      name: 'tmpl', typeKey: 'server_reboot',
      title: 'Standard reboot', bodyDescription: 'Routine',
      fields: REBOOT_FIELDS, plannedDurationMinutes: 90,
    });

    const res = await a.post('/api/changes').send({ templateId: t.body.template.id });
    expect(res.status).toBe(201);
    expect(res.body.change).toMatchObject({
      typeKey: 'server_reboot',
      title: 'Standard reboot',
      description: 'Routine',
      plannedDurationMinutes: 90,
      status: 'draft',
    });
    expect(res.body.change.fields).toMatchObject(REBOOT_FIELDS);

    // Audit row records the template source.
    const audit = row('SELECT details FROM audit_log WHERE change_id = ? AND action = ?',
                      res.body.change.id, 'create');
    expect(JSON.parse(audit.details)).toEqual({ fromTemplateId: t.body.template.id });
  });

  test('body fields override template values', async () => {
    const a = await adminAgent();
    const t = await a.post('/api/change-templates').send({
      name: 'overridable', typeKey: 'server_reboot',
      title: 'Default title', fields: REBOOT_FIELDS, plannedDurationMinutes: 60,
    });
    const res = await a.post('/api/changes').send({
      templateId: t.body.template.id,
      title: 'Specific title',
      plannedDurationMinutes: 120,
    });
    expect(res.body.change.title).toBe('Specific title');
    expect(res.body.change.plannedDurationMinutes).toBe(120);
  });

  test('POST /api/changes with copyFromChangeId clones blueprint, prefixes title, owner = current user', async () => {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');

    // Bob creates the original.
    const orig = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Original',
      fields: REBOOT_FIELDS, plannedDurationMinutes: 30,
    });

    // Admin copies it.
    const copy = await a.post('/api/changes').send({ copyFromChangeId: orig.body.change.id });
    expect(copy.status).toBe(201);
    expect(copy.body.change.title).toBe('Copy of Original');
    expect(copy.body.change.submitter.username).toBe('admin'); // new owner = current user
    expect(copy.body.change.plannedDurationMinutes).toBe(30);
    expect(copy.body.change.fields).toMatchObject(REBOOT_FIELDS);

    // Notes and attachments are NOT copied (the copy starts clean).
    const notes = await a.get(`/api/changes/${copy.body.change.id}/notes`);
    expect(notes.body.notes).toEqual([]);
    const atts = await a.get(`/api/changes/${copy.body.change.id}/attachments`);
    expect(atts.body.attachments).toEqual([]);
  });

  test('rejects unknown templateId / copyFromChangeId', async () => {
    const a = await adminAgent();
    expect((await a.post('/api/changes').send({ templateId: 9999 })).status).toBe(400);
    expect((await a.post('/api/changes').send({ copyFromChangeId: 9999 })).status).toBe(400);
  });

  test('without templateId/copyFromChangeId, typeKey + title are still required', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/changes').send({});
    expect(res.status).toBe(400);
  });
});
