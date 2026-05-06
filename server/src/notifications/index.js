import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendEmail, emailEnabled } from './email.js';
import { sendSMS, smsEnabled } from './sms.js';
import { db } from '../db/index.js';
import { getChangeTypeByKey } from '../services/changeTypes.js';
import { eligibleApproverIds } from '../services/groups.js';

/**
 * Fire a notification for a change-record event.
 * Channels are pluggable: each adapter implements its own enable/send logic.
 *
 * event: one of 'submitted', 'approved', 'rejected', 'implemented', 'closed'
 * change: the change record
 * actor: user who triggered the event
 */
export async function notify(event, { change, actor }) {
  const recipients = recipientsFor(event, change);
  if (!recipients.length) return;

  const subject = subjectFor(event, change);
  const body = bodyFor(event, { change, actor });

  await Promise.allSettled([
    emailEnabled() && wantsChannel('email', event)
      ? sendEmail({ to: recipients.map(r => r.email).filter(Boolean), subject, text: body })
        .catch(err => logger.error({ err: err.message, event }, 'email notify failed'))
      : Promise.resolve(),
    smsEnabled() && wantsChannel('sms', event)
      ? sendSMS({ to: recipients.map(r => r.phone).filter(Boolean), body: `${subject}\n${body}` })
        .catch(err => logger.error({ err: err.message, event }, 'sms notify failed'))
      : Promise.resolve(),
  ]);
}

function wantsChannel(channel, event) {
  const events = config.notifications?.[channel]?.events;
  if (!Array.isArray(events) || !events.length) return true;
  return events.includes(event);
}

function recipientsFor(event, change) {
  if (event === 'submitted') {
    // Same eligibility predicate as the inbox query — anyone who could
    // approve this change should be told it's waiting. Excludes the
    // submitter (segregation of duties).
    const ct = getChangeTypeByKey(change.type_key, { activeOnly: false });
    if (!ct) return [];
    const ids = eligibleApproverIds({
      changeTypeId: ct.id,
      hasApproverGroups: (ct.approverGroups ?? []).length > 0,
      excludeUserId: change.submitter_id,
    });
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id, email, phone, display_name FROM users WHERE id IN (${placeholders})`).all(...ids);
  }
  // approved/rejected/implemented/closed → notify submitter
  return db.prepare('SELECT id, email, phone, display_name FROM users WHERE id = ?').all(change.submitter_id);
}

function subjectFor(event, change) {
  const tag = `[cambiar.world #${change.id}]`;
  switch (event) {
    case 'submitted':   return `${tag} Submitted: ${change.title}`;
    case 'approved':    return `${tag} Approved: ${change.title}`;
    case 'rejected':    return `${tag} Rejected: ${change.title}`;
    case 'implemented': return `${tag} Implemented: ${change.title}`;
    case 'closed':      return `${tag} Closed: ${change.title}`;
    default:            return `${tag} ${event}: ${change.title}`;
  }
}

function bodyFor(event, { change, actor }) {
  const lines = [
    `Change #${change.id}: ${change.title}`,
    `Type: ${change.type_key}`,
    `Status: ${change.status}`,
    actor ? `By: ${actor.display_name || actor.username}` : null,
    '',
    change.description || '',
  ].filter(l => l !== null);
  return lines.join('\n');
}
