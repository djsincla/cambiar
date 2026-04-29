import express from 'express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import changeTypesRouter from './routes/changeTypes.js';
import changesRouter from './routes/changes.js';
import groupsRouter from './routes/groups.js';
import settingsRouter from './routes/settings.js';

/**
 * Build an Express app instance. Migrations and admin bootstrap are NOT
 * performed here — callers (the runtime entry, or test setup) own that.
 */
export function createApp({ httpLogger = true } = {}) {
  const app = express();

  if (httpLogger) {
    app.use(pinoHttp({
      logger,
      customLogLevel: (req, res, err) => err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }));
  }
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));
  app.get('/api', (_req, res) => res.json({
    name: 'cambiar',
    version: '0.1.0',
    endpoints: [
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'GET  /api/auth/me',
      'POST /api/auth/change-password',
      'GET  /api/users (admin)',
      'POST /api/users (admin)',
      'GET  /api/groups',
      'POST /api/groups (admin)',
      'PATCH /api/groups/:id (admin)',
      'DELETE /api/groups/:id (admin)',
      'GET  /api/change-types',
      'POST /api/change-types (admin)',
      'PATCH /api/change-types/:id (admin)',
      'DELETE /api/change-types/:id (admin)',
      'GET  /api/changes',
      'POST /api/changes',
      'GET  /api/changes/:id',
      'PATCH /api/changes/:id',
      'POST /api/changes/:id/{submit,approve,reject,implement,close,rollback}',
    ],
  }));

  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/change-types', changeTypesRouter);
  app.use('/api/changes', changesRouter);

  // Serve uploaded files (logos etc.) — no auth required because the logo is public branding.
  // fallthrough:false so missing files return 404 instead of falling into the SPA catch-all.
  const uploadsDir = resolve(config.dataDir, 'uploads');
  app.use('/uploads', express.static(uploadsDir, { fallthrough: false, maxAge: '1h' }));

  const webDist = resolve(config.repoRoot, 'web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }

  app.use((err, _req, res, _next) => {
    // express.static and other middleware may set err.status / err.statusCode.
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
      return res.status(500).json({ error: 'internal server error' });
    }
    res.status(status).json({ error: err.message });
  });

  return app;
}
