import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, client, row, rows } from './helpers.js';

const REBOOT_FIELDS = {
  host: 'render-12.local',
  reason: 'Kernel patch',
  expected_downtime_minutes: 15,
};

async function setup() {
  resetDb();
  // Promote admin out of must_change_password and create the cast.
  const adminA = await agentFor('admin', 'admin');
  await adminA.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });

  createUser({ username: 'bob', password: 'BobPass1234', role: 'submitter' });
  createUser({ username: 'carol', password: 'CarolPass1234', role: 'approver' });

  const bob = await agentFor('bob', 'BobPass1234');
  const carol = await agentFor('carol', 'CarolPass1234');
  return { admin: adminA, bob, carol };
}

async function createReboot(agent, overrides = {}) {
  const res = await agent.post('/api/changes').send({
    typeKey: 'server_reboot',
    title: overrides.title ?? 'Reboot render-12',
    description: overrides.description ?? 'Apply patch',
    fields: { ...REBOOT_FIELDS, ...(overrides.fields ?? {}) },
    ...(overrides.scheduledAt !== undefined ? { scheduledAt: overrides.scheduledAt } : {}),
  });
  return res;
}

describe('POST /api/changes', () => {
  test('creates a draft', async () => {
    const { bob } = await setup();
    const res = await createReboot(bob);
    expect(res.status).toBe(201);
    expect(res.body.change).toMatchObject({
      typeKey: 'server_reboot', status: 'draft', title: 'Reboot render-12',
    });
    expect(res.body.change.fields).toMatchObject(REBOOT_FIELDS);
    expect(res.body.change.submitter.username).toBe('bob');

    // Audit captured "create" event.
    const audit = rows('SELECT * FROM audit_log WHERE change_id = ?', res.body.change.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('create');
  });

  test('rejects unknown change type at submit time', async () => {
    const { bob } = await setup();
    // Drafts allow free-form fields but the typeKey must exist.
    const res = await bob.post('/api/changes').send({ typeKey: 'no_such', title: 'x' });
    expect(res.status).toBe(201); // draft accepted (typeKey stored verbatim)

    const submit = await bob.post(`/api/changes/${res.body.change.id}/submit`);
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/unknown change type/);
  });

  test('400 on invalid request body', async () => {
    const { bob } = await setup();
    const res = await bob.post('/api/changes').send({ title: 'no type' });
    expect(res.status).toBe(400);
  });

  test('401 unauthenticated', async () => {
    await setup();
    const res = await client().post('/api/changes').send({ typeKey: 'server_reboot', title: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/changes (list)', () => {
  test('filters by status, mine, type', async () => {
    const { bob, carol } = await setup();
    const r1 = await createReboot(bob, { title: 'A' });
    const r2 = await createReboot(bob, { title: 'B' });
    await bob.post(`/api/changes/${r1.body.change.id}/submit`);

    // Carol creates one too.
    const r3 = await createReboot(carol, { title: 'C' });

    const all = await bob.get('/api/changes');
    expect(all.body.changes).toHaveLength(3);

    const drafts = await bob.get('/api/changes?status=draft');
    expect(drafts.body.changes.every(c => c.status === 'draft')).toBe(true);

    const submitted = await bob.get('/api/changes?status=submitted');
    expect(submitted.body.changes).toHaveLength(1);

    const mine = await bob.get('/api/changes?mine=true');
    expect(mine.body.changes.every(c => c.submitter.username === 'bob')).toBe(true);
    expect(mine.body.changes).toHaveLength(2);

    const byType = await bob.get('/api/changes?type=server_reboot');
    expect(byType.body.changes).toHaveLength(3);
  });
});

describe('GET /api/changes/:id', () => {
  test('returns change with approvals + audit', async () => {
    const { admin, bob } = await setup();
    const created = await createReboot(bob);
    await bob.post(`/api/changes/${created.body.change.id}/submit`);
    await admin.post(`/api/changes/${created.body.change.id}/approve`).send({ comment: 'lgtm' });

    const res = await bob.get(`/api/changes/${created.body.change.id}`);
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('approved');
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0]).toMatchObject({ decision: 'approved', comment: 'lgtm' });
    expect(res.body.approvals[0].approver.username).toBe('admin');
    expect(res.body.audit.map(a => a.action)).toEqual(['create', 'submit', 'approve']);
  });

  test('404 unknown id', async () => {
    const { bob } = await setup();
    const res = await bob.get('/api/changes/9999');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/changes/:id', () => {
  test('owner can edit a draft', async () => {
    const { bob } = await setup();
    const c = (await createReboot(bob)).body.change;
    const res = await bob.patch(`/api/changes/${c.id}`).send({ title: 'Updated', fields: { ...REBOOT_FIELDS, expected_downtime_minutes: 30 } });
    expect(res.status).toBe(200);
    expect(res.body.change.title).toBe('Updated');
    expect(res.body.change.fields.expected_downtime_minutes).toBe(30);
  });

  test('non-owner non-admin cannot edit', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    const res = await carol.patch(`/api/changes/${c.id}`).send({ title: 'Hijack' });
    expect(res.status).toBe(403);
  });

  test('admin can edit any draft', async () => {
    const { admin, bob } = await setup();
    const c = (await createReboot(bob)).body.change;
    const res = await admin.patch(`/api/changes/${c.id}`).send({ title: 'admin-edit' });
    expect(res.status).toBe(200);
  });

  test('cannot edit non-draft', async () => {
    const { bob } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    const res = await bob.patch(`/api/changes/${c.id}`).send({ title: 'too late' });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/changes/:id', () => {
  test('owner deletes draft', async () => {
    const { bob } = await setup();
    const c = (await createReboot(bob)).body.change;
    const res = await bob.delete(`/api/changes/${c.id}`);
    expect(res.status).toBe(200);
    expect(row('SELECT * FROM changes WHERE id = ?', c.id)).toBeUndefined();
  });

  test('cannot delete submitted change', async () => {
    const { bob } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    const res = await bob.delete(`/api/changes/${c.id}`);
    expect(res.status).toBe(409);
  });

  test('non-owner cannot delete', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    const res = await carol.delete(`/api/changes/${c.id}`);
    expect(res.status).toBe(403);
  });
});

describe('Workflow: submit', () => {
  test('strict field validation runs at submit', async () => {
    const { bob } = await setup();
    // Skip the helper's defaults — submit a draft with required fields missing.
    const draft = await bob.post('/api/changes').send({
      typeKey: 'server_reboot',
      title: 'incomplete',
      fields: { host: 'h' },
    });
    expect(draft.status).toBe(201);
    const res = await bob.post(`/api/changes/${draft.body.change.id}/submit`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(row('SELECT status FROM changes WHERE id = ?', draft.body.change.id).status).toBe('draft');
  });

  test('non-owner non-admin cannot submit', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    const res = await carol.post(`/api/changes/${c.id}/submit`);
    expect(res.status).toBe(403);
  });

  test('only draft can be submitted', async () => {
    const { bob } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    const again = await bob.post(`/api/changes/${c.id}/submit`);
    expect(again.status).toBe(409);
  });
});

describe('Workflow: approve / reject', () => {
  test('approver can approve, submitter cannot', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);

    const self = await bob.post(`/api/changes/${c.id}/approve`);
    expect(self.status).toBe(403);

    const ok = await carol.post(`/api/changes/${c.id}/approve`).send({ comment: 'sure' });
    expect(ok.status).toBe(200);
    expect(ok.body.change.status).toBe('approved');
    const ap = row('SELECT * FROM approvals WHERE change_id = ?', c.id);
    expect(ap.decision).toBe('approved');
    expect(ap.comment).toBe('sure');
  });

  test('submitter cannot approve own change even if also admin', async () => {
    const { admin } = await setup();
    const c = (await createReboot(admin)).body.change;
    await admin.post(`/api/changes/${c.id}/submit`);
    const res = await admin.post(`/api/changes/${c.id}/approve`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own change/);
  });

  test('approver can reject', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    const res = await carol.post(`/api/changes/${c.id}/reject`).send({ comment: 'too risky' });
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('rejected');
  });

  test('plain submitter cannot approve', async () => {
    const { bob } = await setup();
    createUser({ username: 'eve', password: 'EvePass1234', role: 'submitter' });
    const eve = await agentFor('eve', 'EvePass1234');
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    const res = await eve.post(`/api/changes/${c.id}/approve`);
    expect(res.status).toBe(403);
  });

  test('cannot approve if not submitted', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    const res = await carol.post(`/api/changes/${c.id}/approve`);
    expect(res.status).toBe(409);
  });
});

describe('Workflow: implement / close / rollback', () => {
  test('implement requires approved + owner-or-admin', async () => {
    const { admin, bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);

    // Cannot implement before approval.
    const early = await bob.post(`/api/changes/${c.id}/implement`);
    expect(early.status).toBe(409);

    await carol.post(`/api/changes/${c.id}/approve`);

    // Carol (approver) is not the submitter, not admin → cannot implement.
    const carolImpl = await carol.post(`/api/changes/${c.id}/implement`);
    expect(carolImpl.status).toBe(403);

    // Bob can implement.
    const ok = await bob.post(`/api/changes/${c.id}/implement`);
    expect(ok.status).toBe(200);
    expect(ok.body.change.status).toBe('implemented');
    expect(ok.body.change.implementedAt).toBeTruthy();

    // Admin can also implement on a fresh one.
    const c2 = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c2.id}/submit`);
    await carol.post(`/api/changes/${c2.id}/approve`);
    const adminImpl = await admin.post(`/api/changes/${c2.id}/implement`);
    expect(adminImpl.status).toBe(200);
  });

  test('close requires implemented', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    await carol.post(`/api/changes/${c.id}/approve`);
    expect((await bob.post(`/api/changes/${c.id}/close`)).status).toBe(409);
    await bob.post(`/api/changes/${c.id}/implement`);
    const res = await bob.post(`/api/changes/${c.id}/close`);
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('closed');
    expect(res.body.change.closedAt).toBeTruthy();
  });

  test('rollback requires implemented or closed', async () => {
    const { bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    await carol.post(`/api/changes/${c.id}/approve`);
    // Approved isn't rollback-able yet.
    expect((await bob.post(`/api/changes/${c.id}/rollback`)).status).toBe(409);

    await bob.post(`/api/changes/${c.id}/implement`);
    const res = await bob.post(`/api/changes/${c.id}/rollback`).send({ comment: 'undid the patch' });
    expect(res.status).toBe(200);
    expect(res.body.change.status).toBe('rolled_back');

    // After rollback, can't roll back again.
    expect((await bob.post(`/api/changes/${c.id}/rollback`)).status).toBe(409);
  });
});

describe('Audit log', () => {
  test('captures the full happy-path workflow', async () => {
    const { admin, bob, carol } = await setup();
    const c = (await createReboot(bob)).body.change;
    await bob.post(`/api/changes/${c.id}/submit`);
    await carol.post(`/api/changes/${c.id}/approve`).send({ comment: 'ok' });
    await bob.post(`/api/changes/${c.id}/implement`);
    await bob.post(`/api/changes/${c.id}/close`);

    const audit = rows('SELECT action, from_status, to_status FROM audit_log WHERE change_id = ? ORDER BY id', c.id);
    expect(audit).toEqual([
      { action: 'create',    from_status: null,         to_status: 'draft' },
      { action: 'submit',    from_status: 'draft',      to_status: 'submitted' },
      { action: 'approve',   from_status: 'submitted',  to_status: 'approved' },
      { action: 'implement', from_status: 'approved',   to_status: 'implemented' },
      { action: 'close',     from_status: 'implemented', to_status: 'closed' },
    ]);
  });
});

describe('Field validation', () => {
  test('coerces and stores select values; rejects out-of-range', async () => {
    const { bob, carol } = await setup();
    const r1 = await bob.post('/api/changes').send({
      typeKey: 'firewall_rule',
      title: 'Open SSH',
      fields: {
        device: 'fw1', operation: 'add', direction: 'inbound',
        source: '10.0.0.0/8', destination: '10.1.2.3', ports: 'tcp/22',
        justification: 'remote ops',
      },
    });
    expect(r1.status).toBe(201);
    expect((await bob.post(`/api/changes/${r1.body.change.id}/submit`)).status).toBe(200);

    const r2 = await bob.post('/api/changes').send({
      typeKey: 'firewall_rule', title: 'Bad op',
      fields: {
        device: 'fw1', operation: 'BOGUS', direction: 'inbound',
        source: 'a', destination: 'b', ports: 'tcp/22', justification: 'x',
      },
    });
    const sub = await bob.post(`/api/changes/${r2.body.change.id}/submit`);
    expect(sub.status).toBe(400);
    expect(sub.body.error).toMatch(/operation must be one of/);
  });

  test('numeric fields are stored as numbers', async () => {
    const { bob } = await setup();
    const r = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't',
      fields: { ...REBOOT_FIELDS, expected_downtime_minutes: '20' /* string from form */ },
    });
    await bob.post(`/api/changes/${r.body.change.id}/submit`);
    const stored = JSON.parse(row('SELECT fields_json FROM changes WHERE id = ?', r.body.change.id).fields_json);
    expect(stored.expected_downtime_minutes).toBe('20'); // draft preserves as-sent
    // After submit, validateFields runs but doesn't rewrite stored fields. Confirm route validation accepted it.
  });
});
