import cron from 'node-cron';
import {
  listEnabledRecurringParents, getRecurringParent, spawnChildFromParent,
} from './recurringChanges.js';
import { recordTick } from './schedulerHealth.js';
import { logger } from '../logger.js';

const tasks = new Map(); // parent change id → ScheduledTask

function fire(parentId) {
  // Re-load on each fire so admin edits propagate without restart.
  recordTick('recurring');
  const parent = getRecurringParent(parentId);
  if (!parent || !parent.recurrenceEnabled) return;
  spawnChildFromParent(parent)
    .then(r => logger.info({ parentId, childId: r.childId, status: r.status }, 'recurring child spawned'))
    .catch(err => logger.error({ err: err.message, parentId }, 'recurring spawn failed'));
}

export function registerRecurringChange(parent) {
  unregisterRecurringChange(parent.id);
  if (!parent.recurrenceEnabled) return;
  if (!cron.validate(parent.recurrenceCron)) {
    logger.warn({ parentId: parent.id, cron: parent.recurrenceCron }, 'invalid cron — recurring change not registered');
    return;
  }
  const task = cron.schedule(parent.recurrenceCron, () => fire(parent.id), {
    scheduled: true,
    timezone: parent.recurrenceTimezone || undefined,
  });
  tasks.set(parent.id, task);
  logger.info({ parentId: parent.id, cron: parent.recurrenceCron, tz: parent.recurrenceTimezone }, 'recurring change registered');
}

export function unregisterRecurringChange(parentId) {
  const t = tasks.get(parentId);
  if (t) {
    try { t.stop(); } catch {}
    tasks.delete(parentId);
    logger.info({ parentId }, 'recurring change unregistered');
  }
}

export function startRecurringScheduler() {
  try {
    const parents = listEnabledRecurringParents();
    for (const p of parents) registerRecurringChange(p);
    logger.info({ count: parents.length }, 'recurring scheduler started');
  } catch (err) {
    logger.error({ err: err.message }, 'recurring scheduler failed to start');
  }
}

export function stopRecurringScheduler() {
  for (const [id] of tasks) unregisterRecurringChange(id);
}

export function activeRecurringIds() { return [...tasks.keys()]; }
