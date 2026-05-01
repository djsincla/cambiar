import { db } from '../db/index.js';

export const LINK_KINDS = ['depends_on', 'relates_to'];

const COMPLETE_STATUSES = ['implemented', 'closed'];

function rowToRef(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    typeKey: r.type_key,
    scheduledAt: r.scheduled_at,
  };
}

/**
 * Add a link between two changes.
 * Returns { id } on success, or throws Error with `.code` for the UI:
 *   'self_link', 'duplicate', 'cycle', 'not_found'.
 *
 * Cycle protection only catches the direct A→B / B→A case. Full transitive
 * cycle detection isn't needed today — even if it happens, it's harmless (it
 * just means neither change can start).
 */
export function addLink({ fromChangeId, toChangeId, kind, userId }) {
  if (!LINK_KINDS.includes(kind)) {
    const e = new Error('invalid link kind'); e.code = 'invalid_kind'; throw e;
  }
  if (fromChangeId === toChangeId) {
    const e = new Error('a change cannot link to itself'); e.code = 'self_link'; throw e;
  }
  const a = db.prepare('SELECT id FROM changes WHERE id = ?').get(fromChangeId);
  const b = db.prepare('SELECT id FROM changes WHERE id = ?').get(toChangeId);
  if (!a || !b) {
    const e = new Error('change not found'); e.code = 'not_found'; throw e;
  }
  // Direct cycle on depends_on: if B already depends on A, refuse A→B.
  if (kind === 'depends_on') {
    const reverse = db.prepare(
      `SELECT id FROM change_links WHERE from_change_id = ? AND to_change_id = ? AND kind = 'depends_on'`
    ).get(toChangeId, fromChangeId);
    if (reverse) {
      const e = new Error('that change already depends on this one — cannot create a circular dependency');
      e.code = 'cycle'; throw e;
    }
  }
  // For relates_to, normalize to a single canonical row (lower id first) so
  // adding A→B and then B→A doesn't double up.
  let from = fromChangeId;
  let to = toChangeId;
  if (kind === 'relates_to' && from > to) { [from, to] = [to, from]; }

  try {
    const info = db.prepare(
      `INSERT INTO change_links (from_change_id, to_change_id, kind, created_by) VALUES (?, ?, ?, ?)`
    ).run(from, to, kind, userId ?? null);
    return { id: Number(info.lastInsertRowid) };
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      const e = new Error('link already exists'); e.code = 'duplicate'; throw e;
    }
    throw err;
  }
}

export function removeLink(linkId) {
  const info = db.prepare('DELETE FROM change_links WHERE id = ?').run(linkId);
  return info.changes > 0;
}

export function getLink(linkId) {
  return db.prepare('SELECT * FROM change_links WHERE id = ?').get(linkId);
}

/**
 * All links touching `changeId`, bucketed for the UI:
 *   - dependsOn : changes THIS change depends on (depends_on, this is "from")
 *   - blocks    : changes that depend on this one (depends_on, this is "to")
 *   - blockedBy : subset of dependsOn whose status is not implemented/closed
 *   - relatedTo : symmetric, both directions of relates_to
 * Each entry includes its `linkId` so the UI can call DELETE.
 */
export function getLinksForChange(changeId) {
  const dependsOnRows = db.prepare(`
    SELECT cl.id AS link_id, c.* FROM change_links cl
    JOIN changes c ON c.id = cl.to_change_id
    WHERE cl.from_change_id = ? AND cl.kind = 'depends_on'
    ORDER BY cl.id ASC
  `).all(changeId);

  const blocksRows = db.prepare(`
    SELECT cl.id AS link_id, c.* FROM change_links cl
    JOIN changes c ON c.id = cl.from_change_id
    WHERE cl.to_change_id = ? AND cl.kind = 'depends_on'
    ORDER BY cl.id ASC
  `).all(changeId);

  const relatedRows = db.prepare(`
    SELECT cl.id AS link_id, c.*
    FROM change_links cl
    JOIN changes c ON c.id = CASE WHEN cl.from_change_id = ? THEN cl.to_change_id ELSE cl.from_change_id END
    WHERE cl.kind = 'relates_to' AND (cl.from_change_id = ? OR cl.to_change_id = ?)
    ORDER BY cl.id ASC
  `).all(changeId, changeId, changeId);

  const dependsOn = dependsOnRows.map(r => ({ linkId: r.link_id, ...rowToRef(r) }));
  const blockedBy = dependsOn.filter(r => !COMPLETE_STATUSES.includes(r.status));
  return {
    dependsOn,
    blockedBy,
    blocks: blocksRows.map(r => ({ linkId: r.link_id, ...rowToRef(r) })),
    relatedTo: relatedRows.map(r => ({ linkId: r.link_id, ...rowToRef(r) })),
  };
}

/**
 * Return the prereqs of `changeId` that aren't yet complete. Used to gate
 * /start and /implement. An empty array means "OK to proceed".
 */
export function getBlockingDeps(changeId) {
  return db.prepare(`
    SELECT c.id, c.title, c.status FROM change_links cl
    JOIN changes c ON c.id = cl.to_change_id
    WHERE cl.from_change_id = ? AND cl.kind = 'depends_on'
      AND c.status NOT IN ('implemented', 'closed')
    ORDER BY c.id ASC
  `).all(changeId);
}
