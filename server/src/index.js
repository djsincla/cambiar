import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations, bootstrapAdmin, seedChangeTypesFromConfig } from './db/migrate.js';
import { createApp } from './app.js';
import { startScheduler, stopScheduler } from './services/digestScheduler.js';
import { startEmailPoller, stopEmailPoller } from './services/emailPoller.js';
import { startRecurringScheduler, stopRecurringScheduler } from './services/recurringScheduler.js';

runMigrations();
bootstrapAdmin();
seedChangeTypesFromConfig();
startScheduler();
startEmailPoller();
startRecurringScheduler();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(`Cambiar listening on http://localhost:${config.port}`);
});

const shutdown = (sig) => {
  logger.info({ sig }, 'shutting down');
  stopScheduler();
  stopEmailPoller();
  stopRecurringScheduler();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
