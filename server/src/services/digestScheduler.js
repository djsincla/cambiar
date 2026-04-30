import cron from 'node-cron';
import { listEnabledSchedules, getSchedule } from './digestSchedules.js';
import { runDigest } from './digestRenderer.js';
import { logger } from '../logger.js';

// Map of scheduleId → ScheduledTask. Lets us hot-swap when admins edit.
const tasks = new Map();

function fire(scheduleId) {
  // Re-load the schedule on each fire so any in-flight admin edits are
  // honored without needing a process restart.
  const s = getSchedule(scheduleId);
  if (!s || !s.enabled) return;
  runDigest(s).catch(err => logger.error({ err: err.message, scheduleId }, 'digest fire failed'));
}

export function registerSchedule(schedule) {
  unregisterSchedule(schedule.id);
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cronExpression)) {
    logger.warn({ scheduleId: schedule.id, cron: schedule.cronExpression }, 'invalid cron — schedule not registered');
    return;
  }
  const task = cron.schedule(schedule.cronExpression, () => fire(schedule.id), {
    scheduled: true,
    timezone: schedule.timezone || undefined,
  });
  tasks.set(schedule.id, task);
  logger.info({ scheduleId: schedule.id, name: schedule.name, cron: schedule.cronExpression, tz: schedule.timezone }, 'digest schedule registered');
}

export function unregisterSchedule(scheduleId) {
  const t = tasks.get(scheduleId);
  if (t) {
    try { t.stop(); } catch {}
    tasks.delete(scheduleId);
    logger.info({ scheduleId }, 'digest schedule unregistered');
  }
}

export function startScheduler() {
  // Best-effort startup — failures here shouldn't block the server.
  try {
    const enabled = listEnabledSchedules();
    for (const s of enabled) registerSchedule(s);
    logger.info({ count: enabled.length }, 'digest scheduler started');
  } catch (err) {
    logger.error({ err: err.message }, 'digest scheduler failed to start');
  }
}

export function stopScheduler() {
  for (const [id] of tasks) unregisterSchedule(id);
}

/** Test-only: peek at the active task set. */
export function activeScheduleIds() {
  return [...tasks.keys()];
}
