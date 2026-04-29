import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { db } from './index.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const dir = resolve(__dirname, 'migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT id FROM migrations').all().map(r => r.id));

  for (const file of files) {
    if (applied.has(file)) continue;
    logger.info({ file }, 'applying migration');
    const sql = readFileSync(resolve(dir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations (id) VALUES (?)').run(file);
    });
    tx();
  }
}

export function bootstrapAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (existing) return false;

  const hash = bcrypt.hashSync('admin', 12);
  db.prepare(`
    INSERT INTO users (username, display_name, password_hash, source, role, must_change_password)
    VALUES (?, ?, ?, 'local', 'admin', 1)
  `).run('admin', 'Administrator', hash);

  logger.warn('Bootstrap admin created: username=admin password=admin (change on first login)');
  return true;
}

/**
 * Seed change_types from config/change-types.json on first run only.
 * Once any rows exist, the DB is authoritative and this is a no-op.
 */
export function seedChangeTypesFromConfig() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM change_types').get().c;
  if (existing > 0) return false;

  const path = resolve(config.repoRoot, 'config/change-types.json');
  if (!existsSync(path)) {
    logger.warn({ path }, 'no config/change-types.json to seed');
    return false;
  }
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  const types = cfg.types ?? [];
  if (!types.length) return false;

  const insert = db.prepare(`
    INSERT INTO change_types (key, name, description, icon, fields_json, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const tx = db.transaction(() => {
    for (const t of types) {
      insert.run(t.key, t.name, t.description ?? null, t.icon ?? null, JSON.stringify(t.fields ?? []));
    }
  });
  tx();
  logger.info({ count: types.length }, 'seeded change_types from config');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  bootstrapAdmin();
  seedChangeTypesFromConfig();
  logger.info('migrations complete');
  process.exit(0);
}
