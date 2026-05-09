import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/index.js';
import { signToken, COOKIE_NAME, cookieOptions } from '../auth/jwt.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../auth/passwords.js';
import bcrypt from 'bcrypt';
import { authenticateAD, adEnabled, mapGroupsToRole, userIsAllowedByAD, syncADUserGroups } from '../auth/ad.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth.js';
import { getOrCreateIcalToken, rotateIcalToken } from '../services/icalFeed.js';
import {
  recordEvent, isUserLocked, maybeLockUser, clearLock,
  listRecentEvents, policy as lockoutPolicy,
} from '../services/authEvents.js';

// Pre-computed dummy bcrypt hash. Used when the username doesn't exist so
// the response time doesn't leak existence — verifyPassword runs the full
// cost-12 compare against this and returns false either way.
const TIMING_PADDING_HASH = bcrypt.hashSync('cambiar-timing-padding-not-a-real-password', 12);

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});

// Per-IP rate limit on the login endpoint. Closes online password-spray
// without throttling well-behaved users. bcrypt cost 12 already makes
// offline brute force expensive; this is the matching online defense.
// Skipped in the test suite so existing test fixtures (which do many
// logins in sequence) keep working without per-test resets.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip in vitest (NODE_ENV=test) AND in the Playwright E2E suite, which
  // runs the production server but does many sequential logins.
  skip: () => config.env === 'test' || process.env.CAMBIAR_DISABLE_LOGIN_RATE_LIMIT === '1',
  message: { error: 'too many login attempts — try again in a few minutes' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });
  const { username, password } = parse.data;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] ?? null;

  // 1. Try local first (lets the bootstrap admin always work even if AD is down).
  const localUser = db.prepare(
    `SELECT id, username, email, display_name, password_hash, role, source,
            must_change_password, active, locked_until
     FROM users WHERE username = ? AND source = 'local'`,
  ).get(username);

  // Lockout check is first — even before bcrypt — so a locked account
  // doesn't burn CPU on every spray attempt. The audit row makes the
  // attempt visible.
  if (localUser && isUserLocked(localUser)) {
    recordEvent({ username, ip, userAgent, outcome: 'account_locked', source: 'local', userId: localUser.id });
    return res.status(403).json({
      error: 'account temporarily locked due to repeated failed login attempts; try again later',
      retryAfterMinutes: lockoutPolicy.durationMinutes,
    });
  }

  if (config.auth.local?.enabled !== false) {
    // Run bcrypt either way: against the real hash if the user exists,
    // against a dummy hash otherwise. Flattens timing so unknown vs known
    // username can't be distinguished by response time.
    const ok = await verifyPassword(password, localUser?.password_hash ?? TIMING_PADDING_HASH);

    if (localUser && ok && localUser.active) {
      recordEvent({ username, ip, userAgent, outcome: 'success', source: 'local', userId: localUser.id });
      clearLock(localUser.id);
      return issueSession(res, localUser);
    }
    if (localUser && ok && !localUser.active) {
      recordEvent({ username, ip, userAgent, outcome: 'account_disabled', source: 'local', userId: localUser.id });
      return res.status(403).json({ error: 'account disabled' });
    }
    // Wrong password (or unknown user). Record + maybe lock if local user
    // is real and crossed the threshold.
    if (localUser) {
      recordEvent({ username, ip, userAgent, outcome: 'invalid_credentials', source: 'local', userId: localUser.id });
      if (maybeLockUser(localUser.id, username)) {
        logger.warn({ username, ip }, 'account locked after repeated failed logins');
      }
    }
  }

  // 2. Fall back to AD.
  if (adEnabled()) {
    try {
      const adUser = await authenticateAD(username, password);
      if (adUser) {
        // Allowlist check: when auth.ad.allowedGroups is non-empty, the user
        // must be a member of at least one of those groups.
        if (!userIsAllowedByAD(adUser.groups ?? [])) {
          recordEvent({ username, ip, userAgent, outcome: 'allowlist_rejected', source: 'ad' });
          logger.warn({ username: adUser.username }, 'AD user rejected by allowedGroups');
          return res.status(403).json({ error: 'access not granted to this directory user' });
        }
        const stored = upsertADUser(adUser);
        if (!stored.active) {
          recordEvent({ username, ip, userAgent, outcome: 'account_disabled', source: 'ad', userId: stored.id });
          return res.status(403).json({ error: 'account disabled' });
        }
        // Reconcile Cambiar group memberships from AD groups (auto-creates
        // AD-managed groups, removes the user from synced groups they no
        // longer belong to in AD).
        try {
          syncADUserGroups({ userId: stored.id, adGroups: adUser.groups ?? [] });
        } catch (err) {
          logger.error({ err: err.message, userId: stored.id }, 'AD group sync failed');
          // Don't block login on sync failure — user can still get in with
          // their last-known group set.
        }
        recordEvent({ username, ip, userAgent, outcome: 'success', source: 'ad', userId: stored.id });
        return issueSession(res, stored);
      }
      // AD bind failed (wrong password or unknown user).
      recordEvent({ username, ip, userAgent, outcome: 'invalid_credentials', source: 'ad' });
    } catch (err) {
      logger.error({ err: err.message }, 'AD auth error');
      recordEvent({ username, ip, userAgent, outcome: 'ad_unavailable', source: 'ad' });
      return res.status(503).json({ error: 'directory authentication unavailable' });
    }
  } else if (!localUser) {
    // Neither local user found nor AD enabled — record so unknown-username
    // sprays show up in the audit just like wrong-password ones.
    recordEvent({ username, ip, userAgent, outcome: 'invalid_credentials', source: 'unknown' });
  }

  return res.status(401).json({ error: 'invalid credentials' });
});

// Admin: list recent auth events for the security page.
router.get('/events', requireAuth, blockIfPasswordChangeRequired, requireRole('admin'), (req, res) => {
  res.json({
    events: listRecentEvents({
      limit: req.query.limit,
      outcome: req.query.outcome ? String(req.query.outcome) : null,
    }),
    policy: lockoutPolicy,
  });
});

// Admin: clear a lock (e.g. legitimate user got locked out, can't wait
// out the timer). Targets username so admins don't need to look up an id.
router.post('/clear-lock', requireAuth, blockIfPasswordChangeRequired, requireRole('admin'), (req, res) => {
  const username = String(req.body?.username ?? '');
  if (!username) return res.status(400).json({ error: 'username required' });
  const user = db.prepare(`SELECT id FROM users WHERE username = ? AND source = 'local'`).get(username);
  if (!user) return res.status(404).json({ error: 'no local user with that username' });
  clearLock(user.id);
  // Administrative action, not a login attempt — logged to pino, not into
  // auth_events (which is constrained to login outcomes only).
  logger.info({ username, by: req.user.username, ip: req.ip }, 'lock cleared by admin');
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// Calendar feed token. GET returns the current (creating one on first read);
// POST rotates. The token IS the credential, so we don't return it
// alongside /me by default — only when explicitly asked.
router.get('/me/ical-token', requireAuth, (req, res) => {
  const token = getOrCreateIcalToken(req.user.id);
  res.json({ token, url: buildIcalSubscribeUrl(req, token) });
});

router.post('/me/ical-token/rotate', requireAuth, (req, res) => {
  const token = rotateIcalToken(req.user.id);
  res.json({ token, url: buildIcalSubscribeUrl(req, token) });
});

function buildIcalSubscribeUrl(req, token) {
  // Prefer the configured baseUrl so the link works from outside the LAN.
  // Fall back to the request's host if baseUrl isn't set sensibly.
  const base = (config.baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/ical/upcoming.ics?token=${encodeURIComponent(token)}`;
}

const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

router.post('/change-password', requireAuth, async (req, res) => {
  if (req.user.source !== 'local') {
    return res.status(400).json({ error: 'AD-authenticated users must change password in AD' });
  }
  const parse = changePwSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid request', details: parse.error.flatten() });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const ok = await verifyPassword(parse.data.currentPassword, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'current password incorrect' });

  const minLen = config.auth.local?.passwordMinLength ?? 10;
  const err = validatePasswordStrength(parse.data.newPassword, minLen);
  if (err) return res.status(400).json({ error: err });

  const hash = await hashPassword(parse.data.newPassword);
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(hash, req.user.id);

  res.json({ ok: true });
});

function issueSession(res, user) {
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, cookieOptions());
  return res.json({ user: sanitizeUser(user), token });
}

function sanitizeUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    source: u.source,
    mustChangePassword: Boolean(u.must_change_password),
    phone: u.phone ?? null,
  };
}

function upsertADUser(adUser) {
  const existing = db.prepare(`SELECT * FROM users WHERE username = ? AND source = 'ad'`).get(adUser.username);
  const role = mapGroupsToRole(adUser.groups ?? []);

  if (existing) {
    db.prepare(`
      UPDATE users SET email = ?, display_name = ?, role = COALESCE(?, role), updated_at = datetime('now')
      WHERE id = ?
    `).run(adUser.email, adUser.displayName, existing.role === 'admin' ? null : role, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO users (username, email, display_name, source, role, must_change_password)
    VALUES (?, ?, ?, 'ad', ?, 0)
  `).run(adUser.username, adUser.email, adUser.displayName, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export default router;
