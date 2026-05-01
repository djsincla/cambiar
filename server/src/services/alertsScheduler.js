import cron from 'node-cron';
import { runAlertChecks, alertsEnabled, alertsConfig } from './alerts.js';
import { logger } from '../logger.js';

let task = null;

export function startAlertsScheduler() {
  if (!alertsEnabled()) {
    logger.info('alerts disabled — scheduler not started');
    return;
  }
  const cfg = alertsConfig();
  const minutes = Math.max(1, Math.min(60, Number(cfg.checkIntervalMinutes) || 15));
  const expr = `*/${minutes} * * * *`;
  if (!cron.validate(expr)) {
    logger.warn({ expr }, 'invalid alerts check interval — scheduler not started');
    return;
  }
  task = cron.schedule(expr, () => {
    runAlertChecks().catch(err => logger.error({ err: err.message }, 'alert check failed'));
  }, { scheduled: true });
  logger.info({ intervalMinutes: minutes }, 'alerts scheduler started');
}

export function stopAlertsScheduler() {
  if (task) {
    try { task.stop(); } catch {}
    task = null;
  }
}
