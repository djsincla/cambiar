import { verifyToken, COOKIE_NAME } from '../auth/jwt.js';
import { db } from '../db/index.js';

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] || extractBearer(req);
  if (!token) return res.status(401).json({ error: 'authentication required' });

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }

  const user = db.prepare(
    'SELECT id, username, email, display_name, role, source, must_change_password, active, phone FROM users WHERE id = ?',
  ).get(payload.sub);

  if (!user || !user.active) return res.status(401).json({ error: 'user not found or inactive' });

  req.user = user;
  next();
}

export function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'insufficient role', required: [...allowed] });
    }
    next();
  };
}

/**
 * Mount AFTER requireAuth on protected routers — relies on req.user being set.
 * The auth router never mounts this, so /auth/me, /auth/change-password, and
 * /auth/logout are reachable while the user is in must_change_password state.
 */
export function blockIfPasswordChangeRequired(req, res, next) {
  if (req.user?.must_change_password) {
    return res.status(403).json({ error: 'password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

function extractBearer(req) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7);
}
