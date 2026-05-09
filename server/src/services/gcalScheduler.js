import cron from 'node-cron';
import { runSync } from './gcalSync.js';
import { gcalEnabled, gcalConfig } from './googleCalendar.js';
import { recordTick } from './schedulerHealth.js';
import { logger } from '../logger.js';

let task = null;

export function startGcalScheduler() {
  if (!gcalEnabled()) {
    logger.info('Google Calendar sync disabled — scheduler not started');
    return;
  }
  const cfg = gcalConfig();
  const minutes = Math.max(1, Math.min(60, Number(cfg.syncIntervalMinutes) || 5));
  const expr = `*/${minutes} * * * *`;
  if (!cron.validate(expr)) {
    logger.warn({ expr }, 'invalid gcal sync interval — scheduler not started');
    return;
  }
  task = cron.schedule(expr, () => {
    recordTick('gcal');
    runSync().then(r => {
      if (r.ok && (r.inserted || r.updated || r.deleted || r.errors)) {
        logger.info(r, 'gcal sync pass complete');
      }
    }).catch(err => logger.error({ err: err.message }, 'gcal sync failed'));
  }, { scheduled: true });
  logger.info({ intervalMinutes: minutes }, 'gcal scheduler started');
}

export function stopGcalScheduler() {
  if (task) {
    try { task.stop(); } catch {}
    task = null;
  }
}
