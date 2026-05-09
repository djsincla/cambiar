import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { processEmail } from './emailActions.js';
import { recordTick } from './schedulerHealth.js';

let intervalHandle = null;
let polling = false;

function imapConfig() {
  const incoming = config.notifications?.incoming;
  if (!incoming?.enabled) return null;
  const imap = incoming.imap ?? {};
  const password = process.env.IMAP_PASSWORD ?? '';
  if (!imap.host || !imap.user || !password) {
    logger.warn('email ingestion enabled but IMAP host/user/password incomplete — poller will not start');
    return null;
  }
  return {
    host: imap.host,
    port: imap.port ?? 993,
    secure: imap.secure !== false,
    auth: { user: imap.user, pass: password },
    mailbox: imap.mailbox ?? 'INBOX',
    intervalSeconds: incoming.pollIntervalSeconds ?? 60,
  };
}

function firstAddr(addrField) {
  if (!addrField) return null;
  if (typeof addrField === 'string') return addrField;
  if (Array.isArray(addrField.value) && addrField.value[0]?.address) return addrField.value[0].address;
  if (typeof addrField.text === 'string') return addrField.text;
  return null;
}

export async function pollOnce() {
  const cfg = imapConfig();
  if (!cfg) return { skipped: true, reason: 'imap config incomplete' };
  if (polling) return { skipped: true, reason: 'previous poll still running' };
  polling = true;

  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: cfg.auth,
    logger: false, // imapflow's own logger is verbose
  });

  let processed = 0;
  let errors = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      // Fetch UNSEEN with full source so mailparser can tokenize headers + body.
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, source: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const email = {
            from: firstAddr(parsed.from) ?? firstAddr(msg.envelope?.from?.[0]),
            subject: parsed.subject ?? msg.envelope?.subject ?? '',
            body: parsed.text ?? '',
            messageId: parsed.messageId ?? msg.envelope?.messageId,
            receivedAt: (parsed.date ?? msg.envelope?.date)?.toISOString?.() ?? null,
          };
          await processEmail(email);
          processed++;
        } catch (err) {
          errors++;
          logger.error({ err: err.message, uid: msg.uid }, 'failed to process message');
        }
        // Mark as Seen even on processing error — the email_log records the failure
        // for the admin, and we don't want the poller to loop on the same broken message.
        try { await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']); } catch {}
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    logger.error({ err: err.message }, 'IMAP poll failed');
    try { await client.close(); } catch {}
    return { ok: false, error: err.message, processed, errors };
  } finally {
    polling = false;
  }
  if (processed > 0) logger.info({ processed, errors }, 'email poll complete');
  return { ok: true, processed, errors };
}

export function startEmailPoller() {
  const cfg = imapConfig();
  if (!cfg) {
    logger.info('email ingestion not configured — poller idle');
    return;
  }
  if (intervalHandle) return;

  // Fire once at startup so admins don't wait a full interval after enabling.
  pollOnce().catch(err => logger.error({ err: err.message }, 'initial email poll failed'));
  intervalHandle = setInterval(() => {
    recordTick('email');
    pollOnce().catch(err => logger.error({ err: err.message }, 'email poll failed'));
  }, cfg.intervalSeconds * 1000);
  logger.info({ host: cfg.host, mailbox: cfg.mailbox, intervalSeconds: cfg.intervalSeconds }, 'email poller started');
}

export function stopEmailPoller() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
