import { getUserGroupIdSet } from './groups.js';
import { getChangeTypeByKey } from './changeTypes.js';

/**
 * Annotate raw `changes` rows with viewer-context flags so the UI can
 * render "awaiting your approval" / "your draft" / "awaiting others"
 * hints without making per-row requests.
 *
 * Mutates each row in place to add:
 *   - viewerIsSubmitter: boolean
 *   - viewerCanApprove:  boolean (only meaningful when status='submitted')
 *
 * Loads each distinct change type once (small in practice) so the
 * total cost is one type lookup per type, not per change row.
 */
export function annotateChangesForViewer(rows, user) {
  if (!rows.length) return rows;

  const userGroupIds = getUserGroupIdSet(user.id);
  const typeKeys = [...new Set(rows.map(r => r.type_key))];
  const typeMap = new Map();
  for (const k of typeKeys) {
    const t = getChangeTypeByKey(k, { activeOnly: false });
    if (t) typeMap.set(k, t);
  }

  for (const r of rows) {
    const isSubmitter = r.submitter_id === user.id;
    let canApprove = false;
    if (r.status === 'submitted' && !isSubmitter) {
      if (user.role === 'admin') {
        canApprove = true;
      } else {
        const t = typeMap.get(r.type_key);
        if (t) {
          const groups = t.approverGroups ?? [];
          if (groups.length === 0) {
            canApprove = user.role === 'approver';
          } else {
            canApprove = groups.some(g => userGroupIds.has(g.id));
          }
        }
      }
    }
    r.viewerIsSubmitter = isSubmitter;
    r.viewerCanApprove = canApprove;
  }
  return rows;
}
