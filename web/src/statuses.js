export const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Approved',
  in_progress: 'In progress',
  rejected: 'Rejected',
  implemented: 'Implemented',
  closed: 'Closed',
  rolled_back: 'Rolled back',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status?.replace?.('_', ' ') ?? status;
}

/**
 * Short hint about how a change relates to the current viewer, given the
 * status and the viewerCanApprove / viewerIsSubmitter flags from the API.
 * Returns { text, tone } or null when no hint is appropriate.
 */
export function viewerHint(change) {
  const { status, viewerIsSubmitter, viewerCanApprove } = change;
  if (status === 'submitted') {
    if (viewerCanApprove) return { text: 'awaiting you', tone: 'attention' };
    if (viewerIsSubmitter) return { text: 'awaiting others', tone: 'muted' };
  }
  if (status === 'draft') {
    if (viewerIsSubmitter) return { text: 'your draft', tone: 'muted' };
  }
  if (status === 'approved' && viewerIsSubmitter) {
    return { text: 'ready to start', tone: 'attention' };
  }
  if (status === 'in_progress') {
    if (viewerIsSubmitter) return { text: 'in progress (yours)', tone: 'attention' };
    return { text: 'in progress', tone: 'attention' };
  }
  if (status === 'implemented' && viewerIsSubmitter) {
    return { text: 'ready to close', tone: 'muted' };
  }
  return null;
}
