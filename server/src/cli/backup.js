#!/usr/bin/env node
//
// Take a consistent snapshot of the running cambiar.world instance.
//
// SQLite + WAL mode is NOT safe to copy with `cp` while the server is
// running — the .sqlite file might be missing committed transactions
// that live in the .sqlite-wal sidecar, and copying happens row by row
// with no transactional cut. This CLI uses better-sqlite3's backup API
// (a wrapper around SQLite's online backup) which produces a fully
// consistent snapshot even with the server live.
//
// Usage:
//   npm run backup                              # writes data/backups/cambiar-YYYYMMDD-HHMMSS.sqlite
//   npm run backup -- --out path/to/file.sqlite # specific path
//   npm run backup -- --uploads                 # also bundle data/uploads/ as a tar.gz alongside
//
// Restore: stop cambiar, replace data/cambiar.sqlite with the backup file,
// optionally restore uploads/, start cambiar back up.

import { mkdirSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { db } from '../db/index.js';
import { config, dbPath } from '../config.js';

function pad(n) { return String(n).padStart(2, '0'); }
function timestamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const out = { uploads: false, outPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uploads') out.uploads = true;
    else if (a === '--out' || a === '-o') out.outPath = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: backup [--out PATH] [--uploads]

  --out PATH    write the .sqlite snapshot to PATH
                (default: data/backups/cambiar-<timestamp>.sqlite)
  --uploads     also bundle data/uploads/ next to the snapshot as a .tar.gz`);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const defaultDir = resolve(config.dataDir, 'backups');
  const outPath = args.outPath
    ? resolve(args.outPath)
    : resolve(defaultDir, `cambiar-${timestamp()}.sqlite`);

  mkdirSync(dirname(outPath), { recursive: true });

  const src = dbPath();
  if (src === ':memory:') {
    console.error('refusing to back up a :memory: database');
    process.exit(1);
  }
  if (!existsSync(src)) {
    console.error(`source DB not found at ${src}`);
    process.exit(1);
  }

  console.log(`source:  ${src}`);
  console.log(`target:  ${outPath}`);

  // better-sqlite3 .backup() returns a Promise that resolves with progress.
  await db.backup(outPath);
  const size = statSync(outPath).size;
  console.log(`✓ snapshot written  (${(size / 1024 / 1024).toFixed(2)} MB)`);

  if (args.uploads) {
    const uploadsDir = resolve(config.dataDir, 'uploads');
    if (!existsSync(uploadsDir)) {
      console.log('  (no uploads/ directory — skipping)');
    } else {
      const tarPath = outPath.replace(/\.sqlite$/, '') + '-uploads.tar.gz';
      const r = spawnSync('tar', ['-czf', tarPath, '-C', dirname(uploadsDir), basename(uploadsDir)], { stdio: 'inherit' });
      if (r.status === 0) {
        const tarSize = statSync(tarPath).size;
        console.log(`✓ uploads bundled   (${(tarSize / 1024 / 1024).toFixed(2)} MB) → ${tarPath}`);
      } else {
        console.error(`tar failed (exit ${r.status})`);
        process.exit(r.status ?? 1);
      }
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('backup failed:', err);
  process.exit(1);
});
