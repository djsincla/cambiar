import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../db/index.js';
import { config } from '../config.js';

const DEFAULTS = {
  'branding.app_name': 'cambiar.world',
  'branding.logo_path': null,
};

// Read the project version on every call. The file is small and the JSON
// parse is cheap; doing it live means a `package.json` bump shows up in
// the topbar immediately without needing a process restart (the previous
// startup-cache approach drifted whenever the server ran longer than a
// release cycle).
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(config.repoRoot, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

export function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (r === undefined) return DEFAULTS[key] ?? null;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

export function setSetting(key, value) {
  const v = JSON.stringify(value);
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, v);
}

export function clearSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function getBranding() {
  return {
    appName: getSetting('branding.app_name') ?? 'cambiar.world',
    logoUrl: getSetting('branding.logo_path'),
    version: readVersion(),
  };
}
