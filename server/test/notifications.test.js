import { describe, test, expect, beforeEach, vi } from 'vitest';
import { resetDb, createUser, agentFor, row } from './helpers.js';

// Spy on the channel adapters BEFORE the routes/changes module is imported
// (which it is, transitively, by test/helpers.js → app.js). Vitest hoists vi.mock,
// but we want passthrough behaviour with spies — simpler to just stub at runtime.
import * as email from '../src/notifications/email.js';
import * as sms from '../src/notifications/sms.js';

describe('Notification dispatch', () => {
  let sendEmail, sendSMS;

  beforeEach(() => {
    resetDb();
    sendEmail = vi.spyOn(email, 'sendEmail').mockResolvedValue();
    sendSMS = vi.spyOn(sms, 'sendSMS').mockResolvedValue();
    // Force channels enabled regardless of config/notifications.json on disk.
    vi.spyOn(email, 'emailEnabled').mockReturnValue(true);
    vi.spyOn(sms, 'smsEnabled').mockReturnValue(true);
  });

  test('submit notifies approvers (and admins) but not the submitter', async () => {
    createUser({ username: 'bob', password: 'BobPass1234', email: 'bob@x.com', role: 'submitter' });
    createUser({ username: 'carol', password: 'CarolPass1234', email: 'carol@x.com', role: 'approver' });
    // Promote admin past forced-change so we can compare counts cleanly.
    const adminA = await agentFor('admin', 'admin');
    await adminA.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
    // Set admin email so it's a viable email recipient.
    await adminA.patch(`/api/users/${row("SELECT id FROM users WHERE username='admin'").id}`).send({ email: 'admin@x.com' });

    const bob = await agentFor('bob', 'BobPass1234');
    const created = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't',
      fields: { host: 'h', reason: 'r', expected_downtime_minutes: 1 },
    });
    sendEmail.mockClear(); sendSMS.mockClear();

    await bob.post(`/api/changes/${created.body.change.id}/submit`);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = sendEmail.mock.calls[0][0];
    // Recipients = approver + admin, but NOT bob.
    expect(call.to.sort()).toEqual(['admin@x.com', 'carol@x.com']);
    expect(call.subject).toMatch(/Submitted/);
  });

  test('approve notifies the submitter only', async () => {
    createUser({ username: 'bob', password: 'BobPass1234', email: 'bob@x.com' });
    createUser({ username: 'carol', password: 'CarolPass1234', email: 'carol@x.com', role: 'approver' });
    const bob = await agentFor('bob', 'BobPass1234');
    const carol = await agentFor('carol', 'CarolPass1234');

    const created = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't',
      fields: { host: 'h', reason: 'r', expected_downtime_minutes: 1 },
    });
    await bob.post(`/api/changes/${created.body.change.id}/submit`);
    sendEmail.mockClear();

    await carol.post(`/api/changes/${created.body.change.id}/approve`).send({ comment: 'ok' });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toEqual(['bob@x.com']);
    expect(sendEmail.mock.calls[0][0].subject).toMatch(/Approved/);
  });

  test('SMS fires for events listed in config (approved fires; submitted does not by default)', async () => {
    createUser({ username: 'bob', password: 'BobPass1234', email: 'bob@x.com', phone: '+15551112222' });
    createUser({ username: 'carol', password: 'CarolPass1234', email: 'carol@x.com', phone: '+15553334444', role: 'approver' });
    const bob = await agentFor('bob', 'BobPass1234');
    const carol = await agentFor('carol', 'CarolPass1234');

    const created = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 't',
      fields: { host: 'h', reason: 'r', expected_downtime_minutes: 1 },
    });
    // Default sms.events is ['approved', 'rejected'] — 'submitted' is NOT in that list.
    sendSMS.mockClear();
    await bob.post(`/api/changes/${created.body.change.id}/submit`);
    expect(sendSMS).not.toHaveBeenCalled();

    sendSMS.mockClear();
    await carol.post(`/api/changes/${created.body.change.id}/approve`);
    expect(sendSMS).toHaveBeenCalled();
    expect(sendSMS.mock.calls[0][0].to).toEqual(['+15551112222']); // notifies submitter on approve
  });
});
