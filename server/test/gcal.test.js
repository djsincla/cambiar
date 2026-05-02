// Google Calendar push-sync reconciler. We don't talk to Google in tests —
// the Calendar API client is replaced with an in-memory fake via the
// setCalendarClientForTests seam, plus a config patch that enables the
// integration with a fake credentials path.

import { describe, test, expect, beforeEach } from 'vitest';
import { resetDb, createUser, agentFor } from './helpers.js';
import { db } from '../src/db/index.js';
import { config } from '../src/config.js';
import { setCalendarClientForTests } from '../src/services/googleCalendar.js';
import { runSync } from '../src/services/gcalSync.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

let fakeCalendar;
let credPath;

function makeFake() {
  // Mimics the surface that googleapis.calendar('v3') exposes — only the
  // methods we use. Each call appends to .calls so tests can assert.
  let nextId = 1;
  const events = new Map();
  const calls = [];
  return {
    events: {
      async insert({ requestBody }) {
        const id = `evt_${nextId++}`;
        events.set(id, { ...requestBody });
        calls.push({ op: 'insert', id, body: requestBody });
        return { data: { id } };
      },
      async update({ eventId, requestBody }) {
        events.set(eventId, { ...requestBody });
        calls.push({ op: 'update', id: eventId, body: requestBody });
        return { data: { id: eventId } };
      },
      async delete({ eventId }) {
        events.delete(eventId);
        calls.push({ op: 'delete', id: eventId });
        return {};
      },
    },
    _events: events,
    _calls: calls,
  };
}

async function ctx() {
  resetDb();
  const admin = await agentFor('admin', 'admin');
  await admin.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return { admin };
}

beforeEach(() => {
  // Stand up a fake credentials file (its existence is enough — auth path
  // never runs because we swap the client in directly).
  const dir = mkdtempSync(resolve(tmpdir(), 'gcal-cred-'));
  credPath = resolve(dir, 'creds.json');
  writeFileSync(credPath, JSON.stringify({ client_email: 'svc@test.iam', private_key: '---PEM---' }));

  config.notifications = config.notifications ?? {};
  config.notifications.googleCalendar = {
    enabled: true,
    calendarId: 'primary',
    credentialsFile: credPath,
    syncIntervalMinutes: 5,
  };

  fakeCalendar = makeFake();
  setCalendarClientForTests(fakeCalendar);
});

// Lifecycle endpoints refuse to let a submitter approve their own change,
// so going through /submit + /approve as admin is a dead end for tests
// where admin is the only user. Set state directly on the DB row — these
// tests are about the gcal reconciler, not the lifecycle.
async function makeScheduledChange(admin, { status = 'submitted', title = 't', daysAhead = 2 } = {}) {
  const create = await admin.post('/api/changes').send({
    typeKey: 'server_reboot',
    title,
    fields: REBOOT_FIELDS,
    scheduledAt: new Date(Date.now() + daysAhead * 86_400_000).toISOString(),
    plannedDurationMinutes: 30,
  });
  const id = create.body.change.id;
  if (status !== 'draft') {
    db.prepare(`UPDATE changes SET status = ? WHERE id = ?`).run(status, id);
  }
  return id;
}

// Force updated_at to be strictly later than the current row's value, so
// the reconciler picks the change up on the next pass. SQLite's
// datetime('now') resolves to the second; back-to-back operations land in
// the same bucket and the `updated_at > gcal_synced_at` comparison fails.
function bumpUpdatedAt(id) {
  db.prepare(`UPDATE changes SET updated_at = datetime('now', '+2 seconds') WHERE id = ?`).run(id);
}

describe('Google Calendar reconciler', () => {
  test('inserts an event for a publishable change and stores the event id', async () => {
    const { admin } = await ctx();
    const id = await makeScheduledChange(admin, { status: 'approved', title: 'gcal insert' });

    const r = await runSync();
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(1);

    const stored = db.prepare('SELECT gcal_event_id, gcal_synced_at FROM changes WHERE id = ?').get(id);
    expect(stored.gcal_event_id).toMatch(/^evt_/);
    expect(stored.gcal_synced_at).toBeTruthy();

    const inserted = fakeCalendar._calls.find(c => c.op === 'insert');
    expect(inserted.body.summary).toBe(`[Cambiar #${id}] gcal insert`);
    expect(inserted.body.status).toBe('confirmed'); // approved → confirmed
  });

  test('submitted changes are sent as tentative; non-publishable states (draft) are skipped on first pass', async () => {
    const { admin } = await ctx();
    const subId = await makeScheduledChange(admin, { status: 'submitted', title: 'subbed' });
    const draftId = await makeScheduledChange(admin, { status: 'draft', title: 'just-a-draft' });

    await runSync();
    const subRow = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(subId);
    const draftRow = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(draftId);
    expect(subRow.gcal_event_id).toMatch(/^evt_/);
    expect(draftRow.gcal_event_id).toBeNull();

    const subInsert = fakeCalendar._calls.find(c => c.op === 'insert' && c.body.summary.includes('subbed'));
    expect(subInsert.body.status).toBe('tentative');
  });

  test('updates the existing event when the change is edited', async () => {
    const { admin } = await ctx();
    const id = await makeScheduledChange(admin, { status: 'approved', title: 'orig' });
    await runSync();
    const eventId1 = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(id).gcal_event_id;

    // Move the change forward in time. Edit only allowed on drafts via the
    // PATCH route, so do it directly.
    db.prepare(`UPDATE changes SET title = 'new title' WHERE id = ?`).run(id);
    bumpUpdatedAt(id);

    const r = await runSync();
    expect(r.updated).toBe(1);

    const eventId2 = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(id).gcal_event_id;
    expect(eventId2).toBe(eventId1); // same event, just patched

    const update = fakeCalendar._calls.find(c => c.op === 'update');
    expect(update.body.summary).toBe(`[Cambiar #${id}] new title`);
  });

  test('idempotent — a no-change second pass does not re-call the API', async () => {
    const { admin } = await ctx();
    await makeScheduledChange(admin, { status: 'approved', title: 'once' });
    await runSync();
    const callsAfterFirst = fakeCalendar._calls.length;

    const r = await runSync();
    expect(r.inserted + r.updated + r.deleted).toBe(0);
    expect(fakeCalendar._calls.length).toBe(callsAfterFirst);
  });

  test('deletes the event when the change moves to a non-publishable state', async () => {
    const { admin } = await ctx();
    const id = await makeScheduledChange(admin, { status: 'implemented', title: 'will-close' });
    await runSync();
    const beforeId = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(id).gcal_event_id;
    expect(beforeId).toMatch(/^evt_/);

    db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(id);
    bumpUpdatedAt(id);

    const r = await runSync();
    expect(r.deleted).toBe(1);
    const after = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(id);
    expect(after.gcal_event_id).toBeNull();
    expect(fakeCalendar._calls.find(c => c.op === 'delete')).toBeDefined();
  });

  test('treats a 404 from delete as success (event was already gone in Google Calendar)', async () => {
    const { admin } = await ctx();
    const id = await makeScheduledChange(admin, { status: 'approved', title: 'manually-deleted' });
    await runSync();

    // Simulate a manual delete in Google Calendar by making the next delete throw 404.
    fakeCalendar.events.delete = async () => { const e = new Error('not found'); e.code = 404; throw e; };
    db.prepare(`UPDATE changes SET status = 'closed' WHERE id = ?`).run(id);
    bumpUpdatedAt(id);

    const r = await runSync();
    expect(r.errors).toBe(0);
    expect(r.deleted).toBe(1);
    const after = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(id);
    expect(after.gcal_event_id).toBeNull();
  });

  test('recurring parents are excluded — they are generators, not events', async () => {
    const { admin } = await ctx();
    const create = await admin.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'rec-parent',
      fields: REBOOT_FIELDS, plannedDurationMinutes: 30,
      scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    const id = create.body.change.id;
    await admin.post(`/api/changes/${id}/recurrence`).send({
      cronExpression: '0 2 * * *', timezone: 'UTC', leadMinutes: 0, autoSubmit: true, enabled: true,
    });
    const r = await runSync();
    expect(r.inserted).toBe(0);
    const row = db.prepare('SELECT gcal_event_id FROM changes WHERE id = ?').get(id);
    expect(row.gcal_event_id).toBeNull();
  });

  test('runSync returns ok=false when the integration is disabled', async () => {
    config.notifications.googleCalendar.enabled = false;
    const r = await runSync();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/disabled/);
  });
});

describe('admin gcal API', () => {
  test('non-admin gets 403 on /api/admin/gcal/status', async () => {
    resetDb();
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');
    const r = await bob.get('/api/admin/gcal/status');
    expect(r.status).toBe(403);
  });

  test('admin can read status + trigger sync-now', async () => {
    const { admin } = await ctx();
    await makeScheduledChange(admin, { status: 'approved', title: 'admin-trigger' });

    const status = await admin.get('/api/admin/gcal/status');
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.counts.eligible).toBeGreaterThanOrEqual(1);

    const sync = await admin.post('/api/admin/gcal/sync-now');
    expect(sync.status).toBe(200);
    expect(sync.body.inserted).toBe(1);

    const after = await admin.get('/api/admin/gcal/status');
    expect(after.body.counts.published).toBe(1);
    expect(after.body.counts.neverSynced).toBe(0);
  });
});
