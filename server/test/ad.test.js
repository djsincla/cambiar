// AD authentication tests.
//
// We mock the `ldapts` library so the test exercises authenticateAD's logic
// (bind → search → re-bind → attribute extraction → group→role mapping)
// without depending on a real or stub LDAP server. Mocking ldapts gives a
// fast, deterministic test that verifies the *contract* with the LDAP client
// and the integration with the /api/auth/login route.
//
// For a higher-fidelity test against a live directory, point this at a real
// AD/LDAP server by setting CAMBIAR_AD_TEST_URL (not implemented here).

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';

const SERVICE_DN = 'cn=cambiar-svc,ou=ServiceAccounts,dc=test,dc=local';
const SERVICE_PW = 'svc-secret';

// Backing data the mock client serves.
let DIRECTORY = {};

function resetDirectory() {
  DIRECTORY = {
    alice: {
      dn: 'cn=Alice Smith,ou=Users,dc=test,dc=local',
      password: 'AlicePassword!',
      attributes: {
        sAMAccountName: 'alice',
        mail: 'alice@test.local',
        displayName: 'Alice Smith',
        memberOf: ['cn=Approvers,ou=Groups,dc=test,dc=local'],
      },
    },
    bob: {
      dn: 'cn=Bob Jones,ou=Users,dc=test,dc=local',
      password: 'BobPassword!',
      attributes: {
        sAMAccountName: 'bob',
        mail: 'bob@test.local',
        displayName: 'Bob Jones',
        memberOf: ['cn=Users,ou=Groups,dc=test,dc=local'],
      },
    },
  };
}

// Mock the entire ldapts module. Each `new Client()` returns an object that
// implements just enough of the API for authenticateAD: bind, search, unbind.
vi.mock('ldapts', () => {
  class Client {
    constructor(opts) { this.opts = opts; this.bound = null; }
    async bind(dn, password) {
      // Service-account bind
      if (dn === SERVICE_DN) {
        if (password === SERVICE_PW) { this.bound = dn; return; }
        const err = new Error('invalid credentials'); err.code = 49; throw err;
      }
      // User re-bind
      const user = Object.values(DIRECTORY).find(u => u.dn === dn);
      if (user && password === user.password) { this.bound = dn; return; }
      const err = new Error('invalid credentials'); err.code = 49; throw err;
    }
    async search(_base, opts) {
      // Filter is supplied as a string by authenticateAD (with hex-escaped
      // username). Just check for the username prefix.
      const filter = String(opts?.filter ?? '').toLowerCase();
      const entries = [];
      for (const u of Object.values(DIRECTORY)) {
        if (filter.includes(u.attributes.sAMAccountName.toLowerCase()) ||
            filter.includes(toHex(u.attributes.sAMAccountName))) {
          entries.push({ dn: u.dn, ...u.attributes });
        }
      }
      return { searchEntries: entries, searchReferences: [] };
    }
    async unbind() { this.bound = null; }
  }
  return { Client };
});

function toHex(s) {
  // Match the escape pattern used by authenticateAD's escapeLdap helper for non-special chars too.
  // Tests just need a substring check, so we don't strictly need this — but it covers escaping.
  return Array.from(s).map(c => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

// Wire cambiar's AD config to a fake URL.
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
    groupRoleMap: { Approvers: 'approver' },
  };
  config.adBindPassword = SERVICE_PW;
});

const { resetDb, createUser, client, row } = await import('./helpers.js');

describe('Active Directory authentication', () => {
  beforeEach(() => { resetDb(); resetDirectory(); });

  test('authenticates an AD user, persists local row with mapped role', async () => {
    const res = await client().post('/api/auth/login').send({
      username: 'alice', password: 'AlicePassword!',
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: 'alice',
      email: 'alice@test.local',
      displayName: 'Alice Smith',
      source: 'ad',
      role: 'approver',
    });
    const stored = row(`SELECT * FROM users WHERE username = ? AND source = 'ad'`, 'alice');
    expect(stored).toBeDefined();
    expect(stored.password_hash).toBeNull();
    expect(stored.role).toBe('approver');
  });

  test('user without a mapped group falls back to defaultRole', async () => {
    const res = await client().post('/api/auth/login').send({
      username: 'bob', password: 'BobPassword!',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('submitter');
  });

  test('rejects wrong AD password with 401', async () => {
    const res = await client().post('/api/auth/login').send({
      username: 'alice', password: 'wrong',
    });
    expect(res.status).toBe(401);
  });

  test('returns 401 for unknown AD user (search yields nothing)', async () => {
    const res = await client().post('/api/auth/login').send({
      username: 'nobody', password: 'whatever',
    });
    expect(res.status).toBe(401);
  });

  test('local takes precedence over AD when usernames collide', async () => {
    createUser({ username: 'alice', password: 'LocalAlice12!' });
    const res = await client().post('/api/auth/login').send({
      username: 'alice', password: 'LocalAlice12!',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.source).toBe('local');
  });

  test('subsequent AD login updates email and display name from directory', async () => {
    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });
    const before = row(`SELECT email, display_name FROM users WHERE username = ? AND source = 'ad'`, 'alice');
    expect(before.email).toBe('alice@test.local');

    DIRECTORY.alice.attributes.mail = 'alice.smith@test.local';
    DIRECTORY.alice.attributes.displayName = 'Alice S.';

    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });
    const after = row(`SELECT email, display_name FROM users WHERE username = ? AND source = 'ad'`, 'alice');
    expect(after.email).toBe('alice.smith@test.local');
    expect(after.display_name).toBe('Alice S.');
  });

  test('admin role on existing local row is not downgraded by AD group mapping', async () => {
    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });
    // Promote AD-sourced alice to admin out-of-band.
    const { db } = await import('../src/db/index.js');
    db.prepare(`UPDATE users SET role = 'admin' WHERE username = ? AND source = 'ad'`).run('alice');

    // Login again — alice's AD groups would otherwise re-map her to 'approver'.
    await client().post('/api/auth/login').send({ username: 'alice', password: 'AlicePassword!' });
    const stored = row(`SELECT role FROM users WHERE username = ? AND source = 'ad'`, 'alice');
    expect(stored.role).toBe('admin');
  });
});
