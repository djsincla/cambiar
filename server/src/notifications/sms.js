import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * SMS notifier — pluggable adapter. The Twilio adapter is wired by default
 * but only logs unless `notifications.sms.enabled` is true and credentials
 * are present (avoids accidental sends during development).
 *
 * To wire a real provider, replace the body of `sendViaTwilio` with a call
 * to the official SDK, or add a new adapter and dispatch on `cfg.adapter`.
 */
export function smsEnabled() {
  return Boolean(config.notifications?.sms?.enabled);
}

export async function sendSMS({ to, body }) {
  if (!smsEnabled()) return;
  if (!to || (Array.isArray(to) && to.length === 0)) return;
  const recipients = Array.isArray(to) ? to : [to];
  const adapter = config.notifications.sms.adapter ?? 'twilio';

  switch (adapter) {
    case 'twilio':
      return sendViaTwilio(recipients, body);
    case 'log':
      logger.info({ to: recipients, body }, 'sms (log adapter)');
      return;
    default:
      logger.warn({ adapter }, 'unknown SMS adapter, skipping');
  }
}

async function sendViaTwilio(recipients, body) {
  const cfg = config.notifications.sms.twilio ?? {};
  const sid = cfg.accountSid;
  const token = config.smsAuthToken;
  if (!sid || !token) {
    logger.warn('Twilio SMS configured but credentials missing; skipping');
    return;
  }

  // Lightweight Twilio REST call — avoids pulling in the SDK for an optional channel.
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  for (const to of recipients) {
    const params = new URLSearchParams({ From: cfg.fromNumber, To: to, Body: body });
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    if (!res.ok) {
      const txt = await res.text();
      logger.error({ status: res.status, body: txt, to }, 'twilio send failed');
    } else {
      logger.info({ to }, 'sms sent');
    }
  }
}
