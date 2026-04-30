import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, createGroup, agentFor, row, rows } from './helpers.js';
import { db } from '../src/db/index.js';

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

const REBOOT_FIELDS = { host: 'h.local', reason: 'patch', expected_downtime_minutes: 5 };

describe('auto-approve change types', () => {
  beforeEach(resetDb);

  test('admin can mark a type as auto-approve', async () => {
    const a = await adminAgent();
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    const res = await a.patch(`/api/change-types/${reboot.id}`).send({ autoApprove: true });
    expect(res.status).toBe(200);
    expect(res.body.type.autoApprove).toBe(true);
  });

  test('rejects autoApprove=true together with approverGroupIds (mutual exclusion)', async () => {
    const a = await adminAgent();
    const g = createGroup({ name: 'X' });

    const create = await a.post('/api/change-types').send({
      key: 'standard_thing', name: 'Standard', fields: [],
      autoApprove: true, approverGroupIds: [g.id],
    });
    expect(create.status).toBe(400);
    expect(create.body.error).toMatch(/mutually exclusive/);

    // Patch path: existing type with groups, can't enable autoApprove without clearing groups.
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    await a.patch(`/api/change-types/${reboot.id}`).send({ approverGroupIds: [g.id] });
    const conflict = await a.patch(`/api/change-types/${reboot.id}`).send({ autoApprove: true });
    expect(conflict.status).toBe(400);

    // But it's fine if you clear groups in the same patch.
    const ok = await a.patch(`/api/change-types/${reboot.id}`).send({ autoApprove: true, approverGroupIds: [] });
    expect(ok.status).toBe(200);
    expect(ok.body.type.autoApprove).toBe(true);
    expect(ok.body.type.approverGroups).toEqual([]);
  });

  test('submit on an auto-approve type lands on approved with audit trail', async () => {
    const a = await adminAgent();
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    await a.patch(`/api/change-types/${reboot.id}`).send({ autoApprove: true });

    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');

    const create = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Standard reboot', fields: REBOOT_FIELDS,
    });
    const submit = await bob.post(`/api/changes/${create.body.change.id}/submit`);

    expect(submit.status).toBe(200);
    expect(submit.body.change.status).toBe('approved');
    expect(row('SELECT submitted_at FROM changes WHERE id = ?', create.body.change.id).submitted_at).toBeTruthy();

    // Three audit rows: create + human submit (both have user_id), then system auto_approve (user_id=null).
    const audit = rows('SELECT * FROM audit_log WHERE change_id = ? ORDER BY id', create.body.change.id);
    expect(audit.map(a => ({ action: a.action, from: a.from_status, to: a.to_status, user: a.user_id })))
      .toEqual([
        { action: 'create',       from: null,        to: 'draft',     user: expect.any(Number) },
        { action: 'submit',       from: 'draft',     to: 'submitted', user: expect.any(Number) },
        { action: 'auto_approve', from: 'submitted', to: 'approved',  user: null },
      ]);
  });

  test('auto-approved change is then implementable and closable normally', async () => {
    const a = await adminAgent();
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    await a.patch(`/api/change-types/${reboot.id}`).send({ autoApprove: true });

    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');

    const create = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't', fields: REBOOT_FIELDS,
    });
    await bob.post(`/api/changes/${create.body.change.id}/submit`);

    const impl = await bob.post(`/api/changes/${create.body.change.id}/implement`);
    expect(impl.status).toBe(200);
    expect(impl.body.change.status).toBe('implemented');

    const close = await bob.post(`/api/changes/${create.body.change.id}/close`);
    expect(close.body.change.status).toBe('closed');
  });

  test('field validation still runs at submit on auto-approve types', async () => {
    const a = await adminAgent();
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    await a.patch(`/api/change-types/${reboot.id}`).send({ autoApprove: true });

    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');

    // Required fields missing — submit must fail BEFORE auto-approving.
    const create = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'incomplete', fields: { host: 'h' },
    });
    const submit = await bob.post(`/api/changes/${create.body.change.id}/submit`);
    expect(submit.status).toBe(400);
    // Still draft; nothing was auto-approved.
    expect(row('SELECT status FROM changes WHERE id = ?', create.body.change.id).status).toBe('draft');
  });

  test('flipping auto_approve on does NOT retroactively approve already-submitted changes', async () => {
    createUser({ username: 'bob', password: 'BobPass1234' });
    const a = await adminAgent();
    const bob = await agentFor('bob', 'BobPass1234');

    const create = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'pending', fields: REBOOT_FIELDS,
    });
    await bob.post(`/api/changes/${create.body.change.id}/submit`);
    expect(row('SELECT status FROM changes WHERE id = ?', create.body.change.id).status).toBe('submitted');

    // Now admin flips the type to auto-approve.
    const reboot = (await a.get('/api/change-types/server_reboot')).body.type;
    await a.patch(`/api/change-types/${reboot.id}`).send({ autoApprove: true });

    // The pending change is unchanged.
    expect(row('SELECT status FROM changes WHERE id = ?', create.body.change.id).status).toBe('submitted');
  });
});
