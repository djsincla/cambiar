// Change-to-change links: depends_on (gates start/implement) and relates_to
// (soft, symmetric). The dep gate is the load-bearing piece — the rest is
// CRUD + symmetry/cycle handling.

import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor, rows } from './helpers.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function ctx() {
  resetDb();
  const admin = await agentFor('admin', 'admin');
  await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  const bob = createUser({ username: 'bob', password: 'BobPass1234', role: 'submitter' });
  const carol = createUser({ username: 'carol', password: 'CarolPass1234', role: 'approver' });
  const eve = createUser({ username: 'eve', password: 'EvePass12345', role: 'submitter' });
  return {
    admin,
    bob: { ...bob, agent: await agentFor('bob', 'BobPass1234') },
    carol: { ...carol, agent: await agentFor('carol', 'CarolPass1234') },
    eve: { ...eve, agent: await agentFor('eve', 'EvePass12345') },
  };
}

async function makeApproved(submitter, approver) {
  const c = await submitter.agent.post('/api/changes').send({
    typeKey: 'server_reboot', title: 'Reboot ' + Math.random().toString(36).slice(2, 6),
    fields: REBOOT_FIELDS, plannedDurationMinutes: 30,
  });
  const id = c.body.change.id;
  await submitter.agent.post(`/api/changes/${id}/submit`);
  await approver.agent.post(`/api/changes/${id}/approve`);
  return id;
}

describe('change links — CRUD', () => {
  test('owner can add a depends_on link; detail payload includes it both directions', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);

    const res = await bob.agent.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'depends_on' });
    expect(res.status).toBe(201);
    expect(res.body.links.dependsOn).toHaveLength(1);
    expect(res.body.links.dependsOn[0].id).toBe(b);

    // From B's perspective, A "blocks" it.
    const detailB = await bob.agent.get(`/api/changes/${b}`);
    expect(detailB.body.links.blocks).toHaveLength(1);
    expect(detailB.body.links.blocks[0].id).toBe(a);
  });

  test('relates_to is symmetric — appears under relatedTo from either side', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);
    await bob.agent.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'relates_to' });

    const da = (await bob.agent.get(`/api/changes/${a}`)).body.links;
    const dbd = (await bob.agent.get(`/api/changes/${b}`)).body.links;
    expect(da.relatedTo.map(r => r.id)).toEqual([b]);
    expect(dbd.relatedTo.map(r => r.id)).toEqual([a]);
  });

  test('self-link rejected', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const res = await bob.agent.post(`/api/changes/${a}/links`).send({ toChangeId: a, kind: 'depends_on' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot link to itself/i);
  });

  test('duplicate depends_on rejected', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);
    await bob.agent.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'depends_on' });
    const dup = await bob.agent.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'depends_on' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already exists/i);
  });

  test('reverse depends_on rejected (would create direct cycle)', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);
    await bob.agent.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'depends_on' });
    const reverse = await bob.agent.post(`/api/changes/${b}/links`).send({ toChangeId: a, kind: 'depends_on' });
    expect(reverse.status).toBe(409);
    expect(reverse.body.error).toMatch(/circular/i);
  });

  test('non-owner non-admin cannot link', async () => {
    const { bob, carol, eve } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);
    const res = await eve.agent.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'relates_to' });
    expect(res.status).toBe(403);
  });

  test('admin can link/unlink someone else\'s change', async () => {
    const { admin, bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);
    const add = await admin.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'relates_to' });
    expect(add.status).toBe(201);
    const linkId = add.body.links.relatedTo[0].linkId;
    const del = await admin.delete(`/api/changes/${a}/links/${linkId}`);
    expect(del.status).toBe(200);
    expect(del.body.links.relatedTo).toEqual([]);
  });

  test('DELETE refuses link that doesn\'t touch the path change', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);
    const c = await makeApproved(bob, carol);
    const linkBC = await bob.agent.post(`/api/changes/${b}/links`).send({ toChangeId: c, kind: 'relates_to' });
    const linkId = linkBC.body.links.relatedTo[0].linkId;
    // Try deleting B↔C via change A's path — must 404.
    const res = await bob.agent.delete(`/api/changes/${a}/links/${linkId}`);
    expect(res.status).toBe(404);
  });
});

describe('change links — start/implement gating', () => {
  test('start blocked when prereq not yet implemented; allowed once it is', async () => {
    const { bob, carol } = await ctx();
    const prereq = await makeApproved(bob, carol);
    const dependent = await makeApproved(bob, carol);
    await bob.agent.post(`/api/changes/${dependent}/links`).send({ toChangeId: prereq, kind: 'depends_on' });

    const blocked = await bob.agent.post(`/api/changes/${dependent}/start`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/blocked by/i);
    expect(blocked.body.blockedBy).toHaveLength(1);
    expect(blocked.body.blockedBy[0].id).toBe(prereq);

    // Move prereq to implemented.
    await bob.agent.post(`/api/changes/${prereq}/implement`).send({ actualDurationMinutes: 5 });
    const ok = await bob.agent.post(`/api/changes/${dependent}/start`);
    expect(ok.status).toBe(200);
    expect(ok.body.change.status).toBe('in_progress');
  });

  test('implement also gated when caller skips /start', async () => {
    const { bob, carol } = await ctx();
    const prereq = await makeApproved(bob, carol);
    const dependent = await makeApproved(bob, carol);
    await bob.agent.post(`/api/changes/${dependent}/links`).send({ toChangeId: prereq, kind: 'depends_on' });
    const blocked = await bob.agent.post(`/api/changes/${dependent}/implement`).send({ actualDurationMinutes: 10 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockedBy[0].id).toBe(prereq);
  });

  test('closed prereq is also "complete enough" — does not block', async () => {
    const { bob, carol } = await ctx();
    const prereq = await makeApproved(bob, carol);
    const dependent = await makeApproved(bob, carol);
    await bob.agent.post(`/api/changes/${dependent}/links`).send({ toChangeId: prereq, kind: 'depends_on' });
    await bob.agent.post(`/api/changes/${prereq}/implement`).send({ actualDurationMinutes: 5 });
    await bob.agent.post(`/api/changes/${prereq}/close`);

    const ok = await bob.agent.post(`/api/changes/${dependent}/start`);
    expect(ok.status).toBe(200);
  });

  test('blockedBy in detail payload mirrors the gate', async () => {
    const { bob, carol } = await ctx();
    const prereq = await makeApproved(bob, carol);
    const dependent = await makeApproved(bob, carol);
    await bob.agent.post(`/api/changes/${dependent}/links`).send({ toChangeId: prereq, kind: 'depends_on' });

    const before = (await bob.agent.get(`/api/changes/${dependent}`)).body.links;
    expect(before.blockedBy).toHaveLength(1);
    expect(before.dependsOn).toHaveLength(1);

    await bob.agent.post(`/api/changes/${prereq}/implement`).send({ actualDurationMinutes: 5 });
    const after = (await bob.agent.get(`/api/changes/${dependent}`)).body.links;
    expect(after.blockedBy).toHaveLength(0);
    expect(after.dependsOn).toHaveLength(1);
  });

  test('cascade — deleting a draft change removes its links from both sides', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    // Drafts are deletable; approved aren't. So make B a draft for this test.
    const draftRes = await bob.agent.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Draft', fields: REBOOT_FIELDS, plannedDurationMinutes: 5,
    });
    const draftId = draftRes.body.change.id;
    await bob.agent.post(`/api/changes/${draftId}/links`).send({ toChangeId: a, kind: 'relates_to' });
    expect(rows('SELECT * FROM change_links WHERE from_change_id = ? OR to_change_id = ?', draftId, draftId)).toHaveLength(1);

    await bob.agent.delete(`/api/changes/${draftId}`);
    expect(rows('SELECT * FROM change_links WHERE from_change_id = ? OR to_change_id = ?', draftId, draftId)).toHaveLength(0);
  });

  test('audit log captures add_link and remove_link', async () => {
    const { bob, carol } = await ctx();
    const a = await makeApproved(bob, carol);
    const b = await makeApproved(bob, carol);
    const add = await bob.agent.post(`/api/changes/${a}/links`).send({ toChangeId: b, kind: 'depends_on' });
    const linkId = add.body.links.dependsOn[0].linkId;
    await bob.agent.delete(`/api/changes/${a}/links/${linkId}`);

    const audit = rows('SELECT action FROM audit_log WHERE change_id = ? AND action IN (?, ?) ORDER BY id', a, 'add_link', 'remove_link');
    expect(audit.map(r => r.action)).toEqual(['add_link', 'remove_link']);
  });
});
