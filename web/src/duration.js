/**
 * Format a duration in minutes as a short, readable string:
 *   45  → "45m"
 *   60  → "1h"
 *   90  → "1h30m"
 *   1440 → "24h"
 */
export function fmtDuration(minutes) {
  if (minutes == null || minutes === '') return null;
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return null;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h === 0) return `${mm}m`;
  if (mm === 0) return `${h}h`;
  return `${h}h${mm}m`;
}

/** Variance vs planned. Returns { delta, label, tone } or null. */
export function variance({ planned, actual }) {
  if (planned == null || actual == null) return null;
  const delta = actual - planned;
  if (delta === 0) return { delta, label: 'on target', tone: 'success' };
  if (delta > 0) return { delta, label: `+${fmtDuration(delta)} over`, tone: 'warning' };
  return { delta, label: `${fmtDuration(-delta)} under`, tone: 'success' };
}
