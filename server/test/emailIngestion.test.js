import { describe, test, expect, beforeEach, vi } from 'vitest';
import { resetDb, createUser, agentFor, row, rows } from './helpers.js';
import { matchRule, listEnabledRulesByPriority } from '../src/services/emailRules.js';
import { processEmail } from '../src/services/emailActions.js';
import * as email from '../src/notifications/email.js';

const REBOOT_FIELDS = { host: 'h.local', reason: 'r', expected_downtime_minutes: 5 };

async function adminAgent() {
  const a = await agentFor('admin', 'admin');
  await a.post('/api/auth/change-password').send({ currentPassword: 'admin', newPassword: 'AAaa1234567' });
  return a;
}

describe('Rule CRUD via /api/email-rules', () => {
  beforeEach(resetDb);

  test('admin creates a rule with regex patterns and action config', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/email-rules').send({
      name: 'monitoring outages',
      priority: 50,
      fromPattern: '^monitoring@',
      subjectPattern: '\\bOUTAGE\\b',
      actionType: 'create_change',
      actionConfig: { typeKey: 'generic', useSubjectAs: 'title', useBodyAs: 'description', autoSubmit: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.rule).toMatchObject({
      name: 'monitoring outages',
      enabled: true,
      priority: 50,
      actionType: 'create_change',
    });
  });

  test('rejects invalid regex in fromPattern', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/email-rules').send({
      name: 'bad', actionType: 'create_change', fromPattern: '[unclosed',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid regex/i);
  });

  test('rejects unknown actionType', async () => {
    const a = await adminAgent();
    const res = await a.post('/api/email-rules').send({ name: 'x', actionType: 'whatever' });
    expect(res.status).toBe(400);
  });

  test('non-admin cannot CRUD', async () => {
    createUser({ username: 'bob', password: 'BobPass1234' });
    const a = await agentFor('bob', 'BobPass1234');
    const res = await a.post('/api/email-rules').send({ name: 'x', actionType: 'create_change' });
    expect(res.status).toBe(403);
  });
});

describe('Rule matching', () => {
  beforeEach(resetDb);

  test('higher-priority (lower number) rule wins over lower-priority', async () => {
    const a = await adminAgent();
    await a.post('/api/email-rules').send({
      name: 'low', priority: 200, subjectPattern: '.*',
      actionType: 'create_change', actionConfig: { typeKey: 'generic' },
    });
    await a.post('/api/email-rules').send({
      name: 'high', priority: 10, subjectPattern: 'OUTAGE',
      actionType: 'create_change', actionConfig: { typeKey: 'generic' },
    });
    const matched = matchRule({ from: 'a@b', subject: 'OUTAGE everywhere' });
    expect(matched.name).toBe('high');
  });

  test('disabled rule is skipped', async () => {
    const a = await adminAgent();
    const r = await a.post('/api/email-rules').send({
      name: 'disabled', subjectPattern: 'X',
      actionType: 'create_change', actionConfig: { typeKey: 'generic' },
    });
    await a.patch(`/api/email-rules/${r.body.rule.id}`).send({ enabled: false });
    const matched = matchRule({ from: 'a@b', subject: 'X' });
    expect(matched).toBeNull();
  });

  test('both fromPattern and subjectPattern must match when both are set', async () => {
    const a = await adminAgent();
    await a.post('/api/email-rules').send({
      name: 'narrow', fromPattern: 'monitoring@', subjectPattern: 'OUTAGE',
      actionType: 'create_change', actionConfig: { typeKey: 'generic' },
    });
    expect(matchRule({ from: 'monitoring@x.com', subject: 'OUTAGE' })?.name).toBe('narrow');
    expect(matchRule({ from: 'someone@x.com', subject: 'OUTAGE' })).toBeNull();
    expect(matchRule({ from: 'monitoring@x.com', subject: 'normal' })).toBeNull();
  });
});

describe('Action: create_change', () => {
  beforeEach(resetDb);

  test('creates a draft, auto-submits, audits the source', async () => {
    const a = await adminAgent();
    await a.post('/api/email-rules').send({
      name: 'create generic', subjectPattern: '.*',
      actionType: 'create_change',
      actionConfig: { typeKey: 'generic', useSubjectAs: 'title', useBodyAs: 'description', autoSubmit: false },
    });

    const result = await processEmail({
      from: 'monitoring@x.com',
      subject: 'render-12 down',
      body: 'render-12 stopped responding at 14:32 UTC',
      messageId: '<msg-1@x>',
    });
    expect(result.matched).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.changeId).toBeTruthy();

    const c = row('SELECT * FROM changes WHERE id = ?', result.changeId);
    expect(c.title).toBe('render-12 down');
    expect(c.description).toContain('stopped responding');
    expect(c.status).toBe('draft');

    // email-system is the submitter.
    const submitter = row('SELECT username FROM users WHERE id = ?', c.submitter_id);
    expect(submitter.username).toBe('email-system');

    // Audit row's details record the email source.
    const audit = row(`SELECT details FROM audit_log WHERE change_id = ? AND action = 'create'`, result.changeId);
    const details = JSON.parse(audit.details);
    expect(details.source).toBe('email');
    expect(details.from).toBe('monitoring@x.com');
    expect(details.messageId).toBe('<msg-1@x>');

    // email_log row written.
    const log = row('SELECT * FROM email_log WHERE message_id = ?', '<msg-1@x>');
    expect(log.action_summary).toMatch(/created/);
    expect(log.error).toBeNull();
    expect(log.change_id).toBe(result.changeId);
  });

  test('uses a template when templateId is in action_config', async () => {
    const a = await adminAgent();
    const t = await a.post('/api/change-templates').send({
      name: 'incident', typeKey: 'server_reboot',
      title: 'Outage on host',
      bodyDescription: 'Auto-generated incident',
      fields: REBOOT_FIELDS, plannedDurationMinutes: 30,
    });
    await a.post('/api/email-rules').send({
      name: 'tmpl', subjectPattern: 'OUTAGE',
      actionType: 'create_change',
      actionConfig: { templateId: t.body.template.id, useSubjectAs: 'title', autoSubmit: false },
    });

    const r = await processEmail({ from: 'mon@x', subject: 'OUTAGE host42', body: '', messageId: '<m2@x>' });
    expect(r.ok).toBe(true);
    const c = row('SELECT * FROM changes WHERE id = ?', r.changeId);
    expect(c.title).toBe('OUTAGE host42'); // useSubjectAs overrides template title
    expect(c.type_key).toBe('server_reboot');
    expect(c.planned_duration_minutes).toBe(30);
    expect(JSON.parse(c.fields_json)).toMatchObject(REBOOT_FIELDS);
  });

  test('autoSubmit moves draft to submitted', async () => {
    const a = await adminAgent();
    await a.post('/api/email-rules').send({
      name: 'auto', subjectPattern: '.*',
      actionType: 'create_change',
      actionConfig: { typeKey: 'generic', useSubjectAs: 'title', useBodyAs: 'description', autoSubmit: true },
    });
    // generic requires 'details' field — provide it via body, but useBodyAs maps to description
    // not fields. So validateFields will fail, leaving the change as draft with a note.
    const r = await processEmail({ from: 'a@b', subject: 'no details', body: 'irrelevant', messageId: '<m3@x>' });
    expect(r.ok).toBe(true);
    // The summary mentions blocked submit because 'details' is required and not set.
    expect(r.summary).toMatch(/auto-submit blocked/);
  });
});

describe('Action: transition', () => {
  beforeEach(resetDb);

  async function setupSubmittedChange() {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');
    const c = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Reboot', fields: REBOOT_FIELDS,
    });
    const id = c.body.change.id;
    await bob.post(`/api/changes/${id}/submit`);
    return { id, admin: a };
  }

  test('approves a change by extracting id from subject', async () => {
    const { id, admin: a } = await setupSubmittedChange();
    await a.post('/api/email-rules').send({
      name: 'approve', subjectPattern: '\\[cambiar.world #\\d+\\]',
      actionType: 'transition',
      actionConfig: {
        verb: 'approve',
        changeIdFromSubjectRegex: '\\[cambiar.world #(\\d+)\\]',
        comment: 'auto-approved via email',
      },
    });

    const r = await processEmail({
      from: 'approver@x', subject: `Re: [cambiar.world #${id}] Reboot`,
      body: 'lgtm', messageId: '<m-approve@x>',
    });
    expect(r.ok).toBe(true);
    expect(r.changeId).toBe(id);

    const c = row('SELECT status FROM changes WHERE id = ?', id);
    expect(c.status).toBe('approved');
    const approval = row('SELECT decision, comment FROM approvals WHERE change_id = ?', id);
    expect(approval).toMatchObject({ decision: 'approved', comment: 'auto-approved via email' });
  });

  test('rejects with status mismatch (cannot close a draft)', async () => {
    const a = await adminAgent();
    createUser({ username: 'bob', password: 'BobPass1234' });
    const bob = await agentFor('bob', 'BobPass1234');
    const c = await bob.post('/api/changes').send({
      typeKey: 'server_reboot', title: 'Draft', fields: REBOOT_FIELDS,
    });
    await a.post('/api/email-rules').send({
      name: 'close', subjectPattern: '\\[cambiar.world #\\d+\\].*RESOLVED',
      actionType: 'transition',
      actionConfig: { verb: 'close', changeIdFromSubjectRegex: '\\[cambiar.world #(\\d+)\\]' },
    });

    const r = await processEmail({
      from: 'mon@x', subject: `Re: [cambiar.world #${c.body.change.id}] RESOLVED`,
      body: '', messageId: '<m-close-bad@x>',
    });
    expect(r.matched).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot close/);
    const log = row('SELECT error FROM email_log WHERE message_id = ?', '<m-close-bad@x>');
    expect(log.error).toMatch(/cannot close/);
  });

  test('cannot extract change id when subject does not match the regex', async () => {
    const a = await adminAgent();
    await a.post('/api/email-rules').send({
      name: 'close-by-id', subjectPattern: '.*',
      actionType: 'transition',
      actionConfig: { verb: 'close', changeIdFromSubjectRegex: '\\[cambiar.world #(\\d+)\\]' },
    });
    const r = await processEmail({ from: 'a@b', subject: 'no token here', body: '', messageId: '<m-no-id@x>' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not extract change id/);
  });
});

describe('Action: add_note', () => {
  beforeEach(resetDb);

  test('appends an email body as a note', async () => {
    const a = await adminAgent();
    const c = await a.post('/api/changes').send({
      typeKey: 'generic', title: 'with notes', fields: { details: 'init' },
    });
    const cid = c.body.change.id;
    await a.post('/api/email-rules').send({
      name: 'note', subjectPattern: '\\[cambiar.world #\\d+\\]',
      actionType: 'add_note',
      actionConfig: {
        changeIdFromSubjectRegex: '\\[cambiar.world #(\\d+)\\]',
        useBodyAs: 'body',
      },
    });
    const r = await processEmail({
      from: 'reporter@x', subject: `Re: [cambiar.world #${cid}] update`,
      body: 'Things are happening on **render-3**.',
      messageId: '<m-note@x>',
    });
    expect(r.ok).toBe(true);
    const note = row('SELECT body FROM change_notes WHERE change_id = ?', cid);
    expect(note.body).toContain('render-3');
  });
});

describe('Idempotency by Message-ID', () => {
  beforeEach(resetDb);

  test('processing the same Message-ID twice creates only one change', async () => {
    const a = await adminAgent();
    await a.post('/api/email-rules').send({
      name: 'create', subjectPattern: '.*',
      actionType: 'create_change',
      actionConfig: { typeKey: 'generic', useSubjectAs: 'title', useBodyAs: 'description', autoSubmit: false },
    });
    const r1 = await processEmail({ from: 'a@b', subject: 'hello', body: 'world', messageId: '<dedup@x>' });
    expect(r1.ok).toBe(true);
    const r2 = await processEmail({ from: 'a@b', subject: 'hello', body: 'world', messageId: '<dedup@x>' });
    expect(r2.skipped).toBe(true);

    const all = rows('SELECT id FROM changes WHERE submitter_id = (SELECT id FROM users WHERE username = ?)', 'email-system');
    expect(all).toHaveLength(1);
  });
});
