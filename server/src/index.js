import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations, bootstrapAdmin, seedChangeTypesFromConfig } from './db/migrate.js';
import { createApp } from './app.js';
import { startScheduler, stopScheduler } from './services/digestScheduler.js';
import { startEmailPoller, stopEmailPoller } from './services/emailPoller.js';
import { startRecurringScheduler, stopRecurringScheduler } from './services/recurringScheduler.js';
import { startAlertsScheduler, stopAlertsScheduler } from './services/alertsScheduler.js';
import { startGcalScheduler, stopGcalScheduler } from './services/gcalScheduler.js';

runMigrations();
bootstrapAdmin();
seedChangeTypesFromConfig();
startScheduler();
startEmailPoller();
startRecurringScheduler();
startAlertsScheduler();
startGcalScheduler();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(`cambiar.world listening on http://localhost:${config.port}`);
});

const shutdown = (sig) => {
  logger.info({ sig }, 'shutting down');
  stopScheduler();
  stopEmailPoller();
  stopRecurringScheduler();
  stopAlertsScheduler();
  stopGcalScheduler();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
