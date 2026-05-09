import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations, bootstrapAdmin, seedChangeTypesFromConfig } from './db/migrate.js';
import { createApp } from './app.js';
import { startAllSchedulers, stopAllSchedulers } from './services/schedulerRegistry.js';

runMigrations();
bootstrapAdmin();
seedChangeTypesFromConfig();
startAllSchedulers();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(`cambiar.world listening on http://localhost:${config.port}`);
});

const shutdown = (sig) => {
  logger.info({ sig }, 'shutting down');
  stopAllSchedulers();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
