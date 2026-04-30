import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { requireAuth, blockIfPasswordChangeRequired } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, blockIfPasswordChangeRequired);

const CHANGELOG_PATH = resolve(config.repoRoot, 'CHANGELOG.md');

router.get('/', (_req, res) => {
  if (!existsSync(CHANGELOG_PATH)) {
    return res.json({ content: '# Cambiar\n\nNo CHANGELOG.md found in deployment.', updatedAt: null });
  }
  // Read on each request — cheap (single small file) and keeps the page in
  // sync with edits to CHANGELOG.md without restarting the server.
  const content = readFileSync(CHANGELOG_PATH, 'utf8');
  res.json({ content, updatedAt: null });
});

export default router;
