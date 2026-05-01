// AD allowlist + group/role sync tests. The existing ad.test.js mocks the
// ldapts client; this file builds on the same mock to cover the new
// allowlist gate, group reconciliation, and the AD-managed group lock.

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';

const SERVICE_DN = 'cn=cambiar-svc,ou=ServiceAccounts,dc=test,dc=local';
const SERVICE_PW = 'svc-secret';

let DIRECTORY = {};

function resetDirectory() {
  DIRECTORY = {
    alice: {
      dn: 'cn=Alice Smith,ou=Users,dc=test,dc=local',
      password: 'AlicePassword!',
      attributes: {
        sAMAccountName: 'alice', mail: 'alice@test.local', displayName: 'Alice Smith',
        memberOf: [
          'cn=Cambiar-Users,ou=Groups,dc=test,dc=local',
          'cn=Cambiar-Approvers,ou=Groups,dc=test,dc=local',
        ],
      },
    },
    bob: {
      dn: 'cn=Bob Jones,ou=Users,dc=test,dc=local',
      password: 'BobPassword!',
      attributes: {
        sAMAccountName: 'bob', mail: 'bob@test.local', displayName: 'Bob Jones',
        memberOf: ['cn=Random-Group,ou=Groups,dc=test,dc=local'],
      },
    },
    charlie: {
      dn: 'cn=Charlie,ou=Users,dc=test,dc=local',
      password: 'CharliePassword!',
      attributes: {
        sAMAccountName: 'charlie', mail: 'charlie@test.local', displayName: 'Charlie',
        memberOf: [
          'cn=Cambiar-Users,ou=Groups,dc=test,dc=local',
          'cn=Cambiar-Admins,ou=Groups,dc=test,dc=local',
        ],
      },
    },
  };
}

vi.mock('ldapts', () => {
  class Client {
    constructor(opts) { this.opts = opts; }
    async bind(dn, password) {
      if (dn === SERVICE_DN) {
        if (password === SERVICE_PW) return;
        const e = new Error('invalid credentials'); e.code = 49; throw e;
      }
      const u = Object.values(DIRECTORY).find(x => x.dn === dn);
      if (u && password === u.password) return;
      const e = new Error('invalid credentials'); e.code = 49; throw e;
    }
    async search(_base, opts) {
      const filter = String(opts?.filter ?? '').toLowerCase();
      const out = [];
      for (const u of Object.values(DIRECTORY)) {
        if (filter.includes(u.attributes.sAMAccountName.toLowerCase())) {
          out.push({ dn: u.dn, ...u.attributes });
        }
      }
      return { searchEntries: out, searchReferences: [] };
    }
    async unbind() {}
  }
  return { Client };
});

beforeAll(async () => {
  const { config } = await import('../src/config.js');
  config.auth.ad = {
    enabled: true,
    url: 'ldap://mock.test',
    bindDN: SERVICE_DN,
    searchBase: 'ou=Users,dc=test,dc=local',
    searchFilter: '(sAMAccountName={username})',
    tlsRejectUnauthorized: false,
    attributes: { username: 'sAMAccountName', email: 'mail', displayName: 'displayName' },
    defaultRole: 'submitter',
    // We mutate these per describe block.
    allowedGroups: [],
    groupRoleMap: {},
    groupSync: [],
  };
  config.adBindPassword = SERVICE_PW;
});

const { resetDb, client, row, rows, agentFor } = await import('./helpers.js');
const { config } = await import('../src/config.js');

describe('AD allowedGroups gate', () => {
  beforeEach(() => {
    resetDb();
    resetDirectory();
    config.auth.ad.allowedGroups = ['Cambiar-Users'];
    config.auth.ad.groupSync = [];
  });

  test('user in allowed group → login succeeds', async () => {
    const res = await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });
    expect(res.status).toBe(200);
    expect(res.body.user.source).toBe('ad');
  });

  test('user NOT in any allowed group → 403', async () => {
    const res = await client().post('/api/auth/login').send({ username: 'bob', password: 'BobPassword!' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access not granted/i);
  });

  test('empty allowedGroups → no allowlist (any AD user can log in)', async () => {
    config.auth.ad.allowedGroups = [];
    const res = await client().post('/api/auth/login').send({ username: 'bob', password: 'BobPassword!' });
    expect(res.status).toBe(200);
  });
});

describe('AD groupSync — auto-create + reconcile + lock', () => {
  beforeEach(() => {
    resetDb();
    resetDirectory();
    config.auth.ad.allowedGroups = [];
    config.auth.ad.groupSync = [
      { adGroup: 'Cambiar-Approvers', cambiarGroup: 'Approvers', role: 'approver' },
      { adGroup: 'Cambiar-Admins',    cambiarGroup: 'Admins',    role: 'admin'    },
      { adGroup: 'Cambiar-Users',     cambiarGroup: 'AllUsers' },
    ];
  });

  test('Cambiar groups are auto-created on first login and flagged ad_managed', async () => {
    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });
    const approvers = row("SELECT id, ad_managed FROM groups WHERE name = 'Approvers'");
    const allusers = row("SELECT id, ad_managed FROM groups WHERE name = 'AllUsers'");
    expect(approvers).toBeDefined();
    expect(approvers.ad_managed).toBe(1);
    expect(allusers.ad_managed).toBe(1);
    // alice is in both AD groups → both Cambiar groups
    const aliceGroups = rows(`
      SELECT g.name FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      JOIN users u ON u.id = ug.user_id
      WHERE u.username = 'alice' ORDER BY g.name
    `);
    expect(aliceGroups.map(r => r.name)).toEqual(['AllUsers', 'Approvers']);
  });

  test('removing a user from an AD group removes them from the synced Cambiar group on next login', async () => {
    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });
    expect(rows(`SELECT g.name FROM user_groups ug JOIN groups g ON g.id = ug.group_id JOIN users u ON u.id = ug.user_id WHERE u.username = 'alice'`).map(r => r.name)).toContain('Approvers');

    // AD admin removes alice from the approvers group.
    DIRECTORY.alice.attributes.memberOf = ['cn=Cambiar-Users,ou=Groups,dc=test,dc=local'];
    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });

    const aliceGroups = rows(`SELECT g.name FROM user_groups ug JOIN groups g ON g.id = ug.group_id JOIN users u ON u.id = ug.user_id WHERE u.username = 'alice'`).map(r => r.name);
    expect(aliceGroups).toContain('AllUsers');
    expect(aliceGroups).not.toContain('Approvers');
  });

  test('role is set from groupSync mapping (admin wins over approver)', async () => {
    await client().post('/api/auth/login').send({ username: 'charlie', password: 'CharliePassword!' });
    const u = row(`SELECT role FROM users WHERE username = 'charlie' AND source = 'ad'`);
    expect(u.role).toBe('admin');
  });

  test('AD-managed groups: API refuses PATCH / DELETE / member changes', async () => {
    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });

    // Create a local admin to call admin endpoints.
    const a = await agentFor('admin', 'admin');
    await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });

    const approvers = (await a.get('/api/groups')).body.groups.find(g => g.name === 'Approvers');
    expect(approvers.adManaged).toBe(true);

    const patch = await a.patch(`/api/groups/${approvers.id}`).send({ description: 'tampered' });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toMatch(/AD-managed/i);

    const del = await a.delete(`/api/groups/${approvers.id}`);
    expect(del.status).toBe(409);

    const addMember = await a.post(`/api/groups/${approvers.id}/members`).send({ userId: 1 });
    expect(addMember.status).toBe(409);
  });

  test('groups not flagged ad_managed remain editable as before', async () => {
    const a = await agentFor('admin', 'admin');
    await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
    const created = await a.post('/api/groups').send({ name: 'ManualGroup', description: 'still editable' });
    const patch = await a.patch(`/api/groups/${created.body.group.id}`).send({ description: 'updated' });
    expect(patch.status).toBe(200);
  });
});
