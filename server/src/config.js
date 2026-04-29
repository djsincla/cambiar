import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

dotenv.config({ path: resolve(repoRoot, 'server/.env') });

function readJson(relPath, fallback) {
  const p = resolve(repoRoot, relPath);
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  repoRoot,
  port: Number(process.env.PORT ?? 3000),
  env: process.env.NODE_ENV ?? 'development',
  dataDir: resolve(repoRoot, process.env.DATA_DIR ?? './data'),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  jwt: {
    secret: required('JWT_SECRET'),
    ttlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 43200),
  },

  auth: readJson('config/auth.json', {
    local: { enabled: true },
    ad: { enabled: false },
  }),

  changeTypes: readJson('config/change-types.json', { types: [] }),

  notifications: readJson('config/notifications.json', {
    email: { enabled: false },
    sms: { enabled: false },
  }),

  adBindPassword: process.env.AD_BIND_PASSWORD ?? '',
  smtpPassword: process.env.SMTP_PASSWORD ?? '',
  smsAuthToken: process.env.SMS_AUTH_TOKEN ?? '',
};

export function dbPath() {
  // Allow override for tests (`:memory:` works for in-memory SQLite).
  if (process.env.CAMBIAR_DB_PATH) return process.env.CAMBIAR_DB_PATH;
  return resolve(config.dataDir, 'cambiar.sqlite');
}
