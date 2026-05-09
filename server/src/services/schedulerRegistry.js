// Single point of truth for the long-running tick loops. Adding a new
// scheduler is now a one-line entry in SCHEDULERS — index.js doesn't need
// to learn about it. Each scheduler keeps its own start/stop semantics
// (whether to read config, whether to no-op when disabled, etc.); the
// registry just orders them and isolates failures.

import { logger } from '../logger.js';
import { startScheduler as startDigestScheduler, stopScheduler as stopDigestScheduler } from './digestScheduler.js';
import { startEmailPoller, stopEmailPoller } from './emailPoller.js';
import { startRecurringScheduler, stopRecurringScheduler } from './recurringScheduler.js';
import { startAlertsScheduler, stopAlertsScheduler } from './alertsScheduler.js';
import { startGcalScheduler, stopGcalScheduler } from './gcalScheduler.js';

export const SCHEDULERS = Object.freeze([
  { name: 'digest',    start: startDigestScheduler,    stop: stopDigestScheduler },
  { name: 'email',     start: startEmailPoller,        stop: stopEmailPoller },
  { name: 'recurring', start: startRecurringScheduler, stop: stopRecurringScheduler },
  { name: 'alerts',    start: startAlertsScheduler,    stop: stopAlertsScheduler },
  { name: 'gcal',      start: startGcalScheduler,      stop: stopGcalScheduler },
]);

/**
 * Start every registered scheduler. A failure in one is logged and
 * isolated — the rest still come up. The boot process should not be
 * blocked by, e.g., a misconfigured IMAP poller.
 */
export function startAllSchedulers() {
  for (const s of SCHEDULERS) {
    try { s.start(); }
    catch (err) { logger.error({ err: err.message, scheduler: s.name }, 'scheduler start failed'); }
  }
}

/**
 * Stop every registered scheduler. Errors are swallowed — shutdown is
 * happening anyway and we don't want one bad scheduler to keep the
 * server up.
 */
export function stopAllSchedulers() {
  for (const s of SCHEDULERS) {
    try { s.stop(); } catch {}
  }
}
