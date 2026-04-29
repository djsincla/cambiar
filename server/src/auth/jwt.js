import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, source: user.source },
    config.jwt.secret,
    { expiresIn: config.jwt.ttlSeconds, issuer: 'cambiar' },
  );
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret, { issuer: 'cambiar' });
}

export const COOKIE_NAME = 'cambiar_session';

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: config.jwt.ttlSeconds * 1000,
    path: '/',
  };
}
