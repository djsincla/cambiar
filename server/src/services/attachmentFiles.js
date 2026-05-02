import { unlinkSync, existsSync, rmdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { logger } from '../logger.js';

const UPLOAD_ROOT = resolve(config.dataDir, 'uploads', 'changes');

/**
 * Delete the on-disk file for a given attachment id, if any. Returns true if
 * a file was removed, false otherwise. Safe to call before the DB row is
 * deleted (we look up the row to find the filename).
 */
export function unlinkAttachmentFile(attachmentId) {
  const r = db.prepare('SELECT change_id, filename FROM change_attachments WHERE id = ?').get(attachmentId);
  if (!r) return false;
  return unlinkOnDisk(r.change_id, r.filename);
}

/**
 * Remove every on-disk file referenced by the rows that match the given
 * SQL `where` clause + params. Use this BEFORE the DB rows are deleted —
 * once they're gone, we can't find the filenames.
 *
 * Example:
 *   purgeFilesForAttachments('note_id = ?', [noteId])
 *   purgeFilesForAttachments('change_id = ?', [changeId])
 */
export function purgeFilesForAttachments(whereClause, params) {
  const rows = db.prepare(
    `SELECT change_id, filename FROM change_attachments WHERE ${whereClause}`
  ).all(...params);
  let n = 0;
  for (const r of rows) {
    if (unlinkOnDisk(r.change_id, r.filename)) n++;
  }
  return n;
}

/**
 * Remove the per-change uploads directory if it's empty. No-op otherwise.
 * Called after a change is deleted — leaves the data dir tidy.
 */
export function tryRemoveEmptyChangeDir(changeId) {
  const dir = resolve(UPLOAD_ROOT, String(Number(changeId)));
  if (!dir.startsWith(UPLOAD_ROOT)) return;
  if (!existsSync(dir)) return;
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch (err) {
    logger.warn({ err: err.message, dir }, 'failed to remove empty change upload dir');
  }
}

function unlinkOnDisk(changeId, filename) {
  if (!filename) return false;
  const dir = resolve(UPLOAD_ROOT, String(Number(changeId)));
  const path = resolve(dir, filename);
  if (!path.startsWith(UPLOAD_ROOT)) return false;
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    logger.warn({ err: err.message, path }, 'failed to unlink attachment file');
    return false;
  }
}
