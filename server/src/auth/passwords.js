import bcrypt from 'bcrypt';

const ROUNDS = 12;

export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

export function validatePasswordStrength(plain, minLength = 10) {
  if (typeof plain !== 'string' || plain.length < minLength) {
    return `Password must be at least ${minLength} characters`;
  }
  if (!/[a-z]/.test(plain) || !/[A-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    return 'Password must include upper, lower, and a number';
  }
  return null;
}
