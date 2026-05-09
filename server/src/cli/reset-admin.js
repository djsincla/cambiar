#!/usr/bin/env node
//
// Reset (or create) a local admin account from the host.
//
// Run this on the box where data/cambiar.sqlite lives. There is no API
// equivalent — by design, recovery requires host filesystem access, the same
// trust boundary as the SQLite file itself.
//
// Examples:
//   node server/src/cli/reset-admin.js                  # generate a strong random password
//   node server/src/cli/reset-admin.js -p NewPw!234     # set a specific password
//   node server/src/cli/reset-admin.js -u admin2        # reset (or create) admin2
//
// Behaviour:
//   - If the user does not exist, it's created with role=admin.
//   - If the user exists, only the password and `active=1` are touched —
//     the role is preserved.
//   - The user is forced to change their password on first login.
//   - AD-sourced users are refused (use AD password reset for those).

import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';

const PWCHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generatePassword(len = 20) {
  let pw = '';
  let hasUpper = false, hasLower = false, hasDigit = false;
  while (pw.length < len || !hasUpper || !hasLower || !hasDigit) {
    const c = PWCHARS[crypto.randomInt(0, PWCHARS.length)];
    pw += c;
    if (/[A-Z]/.test(c)) hasUpper = true;
    if (/[a-z]/.test(c)) hasLower = true;
    if (/[0-9]/.test(c)) hasDigit = true;
  }
  return pw;
}

/**
 * Reset (or create) a local user. Returns { username, password, action, generated }.
 * Throws if the named user is AD-sourced.
 */
export function resetUser({ username = 'admin', password = null } = {}) {
  runMigrations();

  const existing = db.prepare('SELECT id, source FROM users WHERE username = ?').get(username);
  if (existing && existing.source !== 'local') {
    throw new Error(`refusing to reset AD-sourced user "${username}" — use AD password reset instead`);
  }

  const generated = !password;
  const finalPassword = password ?? generatePassword();
  const hash = bcrypt.hashSync(finalPassword, 12);

  if (existing) {
    db.prepare(`
      UPDATE users
         SET password_hash = ?, must_change_password = 1, active = 1,
             locked_until = NULL, updated_at = datetime('now')
       WHERE id = ?
    `).run(hash, existing.id);
    return { username, password: finalPassword, action: 'reset', generated };
  }

  db.prepare(`
    INSERT INTO users (username, display_name, password_hash, source, role, must_change_password, active)
    VALUES (?, ?, ?, 'local', 'admin', 1, 1)
  `).run(username, username, hash);
  return { username, password: finalPassword, action: 'created', generated };
}

const USAGE = `Usage: reset-admin [--username NAME] [--password PASSWORD]

  -u, --username NAME       Username to reset or create (default: admin)
  -p, --password PASSWORD   Password to set; if omitted, a strong random one is generated and printed
  -h, --help                Show this help

Operates directly on data/cambiar.sqlite. Requires host access — there is no API equivalent.
- New users are created with role=admin.
- Existing users keep their role; only password and active flag are updated.
- AD-sourced users are refused.
- The user is forced to change the password on first login.
`;

function parseArgs(argv) {
  const args = { username: 'admin', password: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-u' || a === '--username') args.username = argv[++i];
    else if (a === '-p' || a === '--password') args.password = argv[++i];
    else if (a === '-h' || a === '--help') { process.stdout.write(USAGE); process.exit(0); }
    else { process.stderr.write(`unknown option: ${a}\n${USAGE}`); process.exit(2); }
  }
  if (!args.username) { process.stderr.write(USAGE); process.exit(2); }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const r = resetUser(args);
    const verb = r.action === 'created' ? 'Created' : 'Reset';
    process.stdout.write(`${verb} local user "${r.username}".\n`);
    if (r.generated) {
      process.stdout.write(`\n  Username: ${r.username}\n`);
      process.stdout.write(`  Password: ${r.password}\n\n`);
    }
    process.stdout.write(`The user must change this password on first login.\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}
