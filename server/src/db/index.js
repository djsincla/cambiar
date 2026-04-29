import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dbPath, config } from '../config.js';

const path = dbPath();
if (path !== ':memory:') mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path);
if (path !== ':memory:') db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
