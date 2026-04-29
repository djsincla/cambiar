// Runs before each test file. Must set env vars BEFORE the app/db/config
// modules are imported by tests, so we set them here at module top.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.CAMBIAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-production-at-all-12345';
process.env.LOG_LEVEL = 'silent';
process.env.PORT = '0';
// Tests write uploads to an isolated tmp dir so we don't pollute repo data/.
const TMP = mkdtempSync(resolve(tmpdir(), 'cambiar-test-'));
process.env.DATA_DIR = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

// Force a fresh migrate against the in-memory DB. Importing here so that
// the singleton DB is opened with the env above already in place.
const { runMigrations, bootstrapAdmin, seedChangeTypesFromConfig } = await import('../src/db/migrate.js');
runMigrations();
bootstrapAdmin();
seedChangeTypesFromConfig();
