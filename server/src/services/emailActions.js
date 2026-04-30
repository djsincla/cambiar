import { db } from '../db/index.js';
import { logger } from '../logger.js';
import { recordAudit } from './audit.js';
import { getChangeTypeByKey, validateFields } from './changeTypes.js';
import { notify } from '../notifications/index.js';

let _emailSystemUserId = null;

/**
 * Look up (or create) the synthetic 'email-system' user that owns email-driven
 * changes. Migration 009 inserts it; this function is a fallback if a test or
 * stray reset wiped it.
 */
export function ensureEmailSystemUser() {
  if (_emailSystemUserId != null) {
    const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(_emailSystemUserId);
    if (exists) return _emailSystemUserId;
    _emailSystemUserId = null;
  }
  const r = db.prepare("SELECT id FROM users WHERE username = 'email-system'").get();
  if (r) { _emailSystemUserId = r.id; return r.id; }
  const info = db.prepare(`
    INSERT INTO users (username, display_name, source, role, active, password_hash)
    VALUES ('email-system', 'System (email ingestion)', 'local', 'submitter', 0,
            '$2b$12$EmailSystemPlaceholderNotARealHashIntentionallyInvalidXXXXX')
  `).run();
  _emailSystemUserId = Number(info.lastInsertRowid);
  return _emailSystemUserId;
}

function logEmail({ messageId, fromAddr, subject, receivedAt, ruleId, summary, error, changeId }) {
  return db.prepare(`
    INSERT INTO email_log (message_id, from_addr, subject, received_at, matched_rule_id, action_summary, error, change_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(messageId ?? null, fromAddr ?? null, subject ?? null, receivedAt ?? null,
         ruleId ?? null, summary ?? null, error ?? null, changeId ?? null);
}

function extractChangeId(subject, regex) {
  if (!regex || !subject) return null;
  try {
    const m = new RegExp(regex).exec(subject);
    if (m && m[1]) return Number(m[1]);
  } catch {}
  return null;
}

/** Action: create_change. */
async function doCreateChange({ rule, email, sysUserId }) {
  const cfg = rule.actionConfig ?? {};

  // Resolve a template if specified.
  let seed = null;
  if (cfg.templateId) {
    const t = db.prepare('SELECT type_key, title, body_description, fields_json, planned_duration_minutes FROM change_templates WHERE id = ?').get(cfg.templateId);
    if (!t) throw new Error(`templateId ${cfg.templateId} not found`);
    seed = {
      typeKey: t.type_key,
      title: t.title,
      description: t.body_description,
      fields: t.fields_json ? JSON.parse(t.fields_json) : {},
      plannedDurationMinutes: t.planned_duration_minutes,
    };
  }

  const typeKey = cfg.typeKey ?? seed?.typeKey;
  if (!typeKey) throw new Error('action_config.typeKey or templateId is required');
  if (!getChangeTypeByKey(typeKey, { activeOnly: false })) {
    throw new Error(`unknown change type: ${typeKey}`);
  }

  // Subject/body mapping.
  const titleFromEmail = cfg.useSubjectAs === 'title' ? email.subject : null;
  const descFromEmail = cfg.useBodyAs === 'description' ? (email.body ?? '') : null;
  const title = titleFromEmail || seed?.title || `Email: ${email.subject?.slice(0, 100) || '(no subject)'}`;
  const description = descFromEmail ?? seed?.description ?? null;
  const fields = seed?.fields ?? {};
  const planned = seed?.plannedDurationMinutes ?? null;

  // Insert as draft, owned by email-system.
  const txInsert = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO changes (type_key, title, description, fields_json, status, submitter_id, planned_duration_minutes)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(typeKey, title, description, JSON.stringify(fields), sysUserId, planned);
    const id = Number(info.lastInsertRowid);
    recordAudit({
      changeId: id, userId: sysUserId, action: 'create', toStatus: 'draft',
      details: { source: 'email', from: email.from, subject: email.subject, messageId: email.messageId, ruleId: rule.id },
    });
    return id;
  });
  const changeId = txInsert();

  // Optionally submit (and if the type is auto-approve, the type's behavior carries it forward).
  if (cfg.autoSubmit !== false) {
    const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId);
    const v = validateFields(change.type_key, JSON.parse(change.fields_json));
    if (!v.ok) {
      // Field-validation failure on auto-submit: leave as draft, surface in summary.
      return { changeId, summary: `created draft #${changeId} (auto-submit blocked: ${v.error})` };
    }
    const ct = getChangeTypeByKey(change.type_key, { activeOnly: false });
    const txSubmit = db.transaction(() => {
      db.prepare(`UPDATE changes SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(changeId);
      recordAudit({ changeId, userId: sysUserId, action: 'submit', fromStatus: 'draft', toStatus: 'submitted' });
      if (ct?.autoApprove) {
        db.prepare(`UPDATE changes SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(changeId);
        recordAudit({
          changeId, userId: null, action: 'auto_approve',
          fromStatus: 'submitted', toStatus: 'approved',
          details: { reason: 'change type configured for auto-approval' },
        });
      }
    });
    txSubmit();
    if (ct?.autoApprove) {
      await notify('approved', { change: db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId), actor: { id: sysUserId, username: 'email-system' } });
    } else {
      await notify('submitted', { change: db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId), actor: { id: sysUserId, username: 'email-system' } });
    }
  }

  return { changeId, summary: `created change #${changeId} (${typeKey})` };
}

const VALID_VERBS = ['submit', 'approve', 'reject', 'start', 'implement', 'close', 'rollback'];

const VERB_TRANSITIONS = {
  submit:     { from: ['draft'],                     to: 'submitted',   stamp: 'submitted_at' },
  approve:    { from: ['submitted'],                 to: 'approved',    stamp: null },
  reject:     { from: ['submitted'],                 to: 'rejected',    stamp: null },
  start:      { from: ['approved'],                  to: 'in_progress', stamp: 'in_progress_at' },
  implement:  { from: ['approved', 'in_progress'],   to: 'implemented', stamp: 'implemented_at' },
  close:      { from: ['implemented'],               to: 'closed',      stamp: 'closed_at' },
  rollback:   { from: ['in_progress', 'implemented', 'closed'], to: 'rolled_back', stamp: null },
};

/** Action: transition. */
async function doTransition({ rule, email, sysUserId }) {
  const cfg = rule.actionConfig ?? {};
  const verb = cfg.verb;
  if (!VALID_VERBS.includes(verb)) throw new Error(`action_config.verb must be one of ${VALID_VERBS.join(', ')}`);

  const changeId = extractChangeId(email.subject, cfg.changeIdFromSubjectRegex);
  if (!changeId) throw new Error('could not extract change id from subject (changeIdFromSubjectRegex did not match)');

  const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId);
  if (!change) throw new Error(`change #${changeId} not found`);

  const t = VERB_TRANSITIONS[verb];
  if (!t.from.includes(change.status)) {
    throw new Error(`cannot ${verb} a change in '${change.status}' (must be in: ${t.from.join(', ')})`);
  }

  const stampClause = t.stamp ? `, ${t.stamp} = datetime('now')` : '';
  db.prepare(`UPDATE changes SET status = ?${stampClause}, updated_at = datetime('now') WHERE id = ?`)
    .run(t.to, changeId);
  recordAudit({
    changeId, userId: sysUserId, action: verb,
    fromStatus: change.status, toStatus: t.to,
    details: { source: 'email', from: email.from, subject: email.subject, messageId: email.messageId, ruleId: rule.id, comment: cfg.comment ?? null },
  });

  // For approve/reject also write an approvals row.
  if (verb === 'approve' || verb === 'reject') {
    db.prepare(`INSERT INTO approvals (change_id, approver_id, decision, comment) VALUES (?, ?, ?, ?)`)
      .run(changeId, sysUserId, verb === 'approve' ? 'approved' : 'rejected', cfg.comment ?? 'via email');
  }

  // Notify on terminal-ish events.
  const event = { submit: 'submitted', approve: 'approved', reject: 'rejected', implement: 'implemented', close: 'closed' }[verb];
  if (event) {
    await notify(event, { change: db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId), actor: { id: sysUserId, username: 'email-system' } });
  }

  return { changeId, summary: `${verb} change #${changeId} (${change.status} → ${t.to})` };
}

/** Action: add_note. */
async function doAddNote({ rule, email, sysUserId }) {
  const cfg = rule.actionConfig ?? {};
  const changeId = extractChangeId(email.subject, cfg.changeIdFromSubjectRegex);
  if (!changeId) throw new Error('could not extract change id from subject (changeIdFromSubjectRegex did not match)');

  const change = db.prepare('SELECT id FROM changes WHERE id = ?').get(changeId);
  if (!change) throw new Error(`change #${changeId} not found`);

  const body = cfg.useBodyAs === 'body' ? (email.body ?? '') : (email.body ?? email.subject ?? '');
  const trimmed = body.trim();
  if (!trimmed) throw new Error('email body is empty — nothing to write as a note');

  const info = db.prepare(`INSERT INTO change_notes (change_id, user_id, body) VALUES (?, ?, ?)`)
    .run(changeId, sysUserId, trimmed);
  recordAudit({
    changeId, userId: sysUserId, action: 'note_add',
    details: { source: 'email', from: email.from, subject: email.subject, messageId: email.messageId, ruleId: rule.id, noteId: Number(info.lastInsertRowid) },
  });
  return { changeId, summary: `added note to change #${changeId}` };
}

const ACTIONS = {
  create_change: doCreateChange,
  transition:    doTransition,
  add_note:      doAddNote,
};

/**
 * Process one parsed email: match against rules, run the matched action,
 * record everything in email_log. Returns the log row.
 *
 * @param {{from?: string, subject?: string, body?: string, messageId?: string, receivedAt?: string}} email
 */
export async function processEmail(email) {
  const sysUserId = ensureEmailSystemUser();

  // De-dupe: if we've already processed this Message-ID successfully, skip.
  if (email.messageId) {
    const dup = db.prepare('SELECT id FROM email_log WHERE message_id = ? AND error IS NULL').get(email.messageId);
    if (dup) {
      logger.info({ messageId: email.messageId }, 'email already processed, skipping');
      return { skipped: true, reason: 'duplicate message-id' };
    }
  }

  const { matchRule } = await import('./emailRules.js');
  const rule = matchRule({ from: email.from, subject: email.subject });
  if (!rule) {
    logEmail({
      messageId: email.messageId, fromAddr: email.from, subject: email.subject,
      receivedAt: email.receivedAt, ruleId: null, summary: 'no rule matched',
      error: null, changeId: null,
    });
    return { matched: false };
  }

  const fn = ACTIONS[rule.actionType];
  if (!fn) {
    logEmail({
      messageId: email.messageId, fromAddr: email.from, subject: email.subject,
      receivedAt: email.receivedAt, ruleId: rule.id, summary: null,
      error: `unknown action_type: ${rule.actionType}`, changeId: null,
    });
    return { matched: true, ok: false, error: `unknown action_type: ${rule.actionType}` };
  }

  try {
    const result = await fn({ rule, email, sysUserId });
    logEmail({
      messageId: email.messageId, fromAddr: email.from, subject: email.subject,
      receivedAt: email.receivedAt, ruleId: rule.id, summary: result.summary,
      error: null, changeId: result.changeId ?? null,
    });
    return { matched: true, ok: true, ...result };
  } catch (err) {
    logger.error({ err: err.message, ruleId: rule.id }, 'email action failed');
    logEmail({
      messageId: email.messageId, fromAddr: email.from, subject: email.subject,
      receivedAt: email.receivedAt, ruleId: rule.id, summary: null,
      error: err.message, changeId: null,
    });
    return { matched: true, ok: false, error: err.message };
  }
}

export function listEmailLog({ limit = 100, offset = 0, errorsOnly = false } = {}) {
  const where = errorsOnly ? 'WHERE error IS NOT NULL' : '';
  return db.prepare(`
    SELECT l.*, r.name AS rule_name
    FROM email_log l LEFT JOIN email_rules r ON r.id = l.matched_rule_id
    ${where}
    ORDER BY l.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset).map(r => ({
    id: r.id,
    messageId: r.message_id,
    fromAddr: r.from_addr,
    subject: r.subject,
    receivedAt: r.received_at,
    matchedRule: r.matched_rule_id ? { id: r.matched_rule_id, name: r.rule_name } : null,
    actionSummary: r.action_summary,
    error: r.error,
    changeId: r.change_id,
    processedAt: r.processed_at,
  }));
}
