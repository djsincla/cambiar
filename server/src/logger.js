import pino from 'pino';
import { createRequire } from 'node:module';
import { config } from './config.js';

const require = createRequire(import.meta.url);
let prettyAvailable = false;
try { require.resolve('pino-pretty'); prettyAvailable = true; } catch {}

export const logger = pino({
  level: config.logLevel,
  transport: config.env === 'development' && prettyAvailable
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});
